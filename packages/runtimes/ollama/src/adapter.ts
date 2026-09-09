import type {
  AcquireOptions,
  AcquireResult,
  Capabilities,
  DeclaredLimits,
  Endpoint,
  HealthStatus,
  IdentityCheck,
  Logger,
  ManagedProcess,
  ModelInfo,
  OptionValidationContext,
  ProbeQuestion,
  ProbeResult,
  ProbeTarget,
  ProcessExecutor,
  ResidencyContext,
  RuntimeAdapter,
  RuntimeInstance,
  WaitOptions,
} from '@llm-runtime-dock/core';
import {
  createProcessExecutor,
  executableAvailable,
  gatewayError,
  httpJson,
  joinUrl,
  nullLogger,
  probeHealth,
  resolveAuthValue,
  suggestKeyForServedId,
  waitUntilHealthy,
} from '@llm-runtime-dock/core';
import type { OllamaOptions } from './options.js';
import {
  OLLAMA_OPTION_SPECS,
  OLLAMA_RESERVED_ARGS,
  OLLAMA_SERVER_SCOPED_OPTION_KEYS,
  renderOllamaEnv,
  validateOllamaOptions,
} from './options.js';

/**
 * Ollama adapter (spec §20).
 *
 * Three things shape it. Ollama is a multi-model server that auto-loads on
 * request and evicts on its own schedule, so the gateway has to drive residency
 * explicitly and confirm it before reporting ready (§8, §16). Its whole
 * lifecycle API is HTTP — load, unload, `ps`, `tags` — and the `ollama`
 * executable is needed for exactly one thing, `ollama serve`, which is why a
 * server this adapter can reach but not spawn is still perfectly usable. And
 * `ollama serve` is configured entirely through the environment: it accepts no
 * flags at all, which is why every curated option renders an `OLLAMA_*`
 * variable and `extra_args` is refused at load time (see `options.ts`).
 */

export interface OllamaAdapterOptions {
  /** Executable name or path. */
  readonly binary?: string;
  /**
   * Arguments placed before the runtime's own, for when the executable is a
   * launcher rather than the tool itself — `node script.mjs`. A shebang script
   * is not directly executable on Windows, so this is how a script-based
   * command stays portable.
   */
  readonly binaryArgs?: readonly string[];
  readonly executor?: ProcessExecutor;
  readonly logger?: Logger;
  readonly startupTimeoutMs?: number;
  readonly loadTimeoutMs?: number;
}

/**
 * Ollama exposes `serveEnv` and `declaredLimits` beyond the core contract: the
 * spawn environment, which tests assert against so server-scoped options are
 * known to reach the process, and the declared context window.
 */
export interface OllamaAdapter extends RuntimeAdapter {
  serveEnv(runtime: RuntimeInstance): Record<string, string>;
  declaredLimits(runtime: RuntimeInstance): DeclaredLimits;
}

/**
 * `/api/tags` and `/api/ps` return the same entry shape; only the meaning of
 * the list differs — installed versus resident. Old Ollama builds spell the
 * name `name`, newer ones `model`, so both are read.
 */
interface OllamaModel {
  readonly name?: string;
  readonly model?: string;
}

interface ModelListResponse {
  readonly models?: OllamaModel[];
}

const DEFAULT_PORT = 11434;

/**
 * Normalize an Ollama model reference to its tag-qualified spelling (§17).
 *
 * `/api/ps` and `/api/tags` always answer with a tag; a configuration file
 * usually omits `:latest`. Every residency comparison in this file therefore
 * runs both sides through here — miss one side and the adapter unloads the
 * model it just loaded, or fails to recognise a kept sibling.
 *
 * The tag separator is only ever in the *last* path segment: the colon in
 * `localhost:5000/mymodel` is a registry port, and a bare `includes(':')` reads
 * it as a tag and leaves the name unnormalized.
 */
const tagged = (model: string): string => {
  const name = model.slice(model.lastIndexOf('/') + 1);
  return name.includes(':') ? model : `${model}:latest`;
};

export { DEFAULT_PORT };

export const createOllamaAdapter = (options: OllamaAdapterOptions = {}): OllamaAdapter => {
  const id = 'ollama';
  const modelRelease = 'unload_model' as const;
  const defaultProbeTarget = `http://127.0.0.1:${DEFAULT_PORT}`;
  const binary = options.binary ?? process.env.LRD_OLLAMA_BIN ?? 'ollama';
  const binaryArgs = options.binaryArgs ?? [];
  const logger = options.logger ?? nullLogger;
  const executor = options.executor ?? createProcessExecutor(logger);
  const startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 300_000;
  /** Servers this adapter spawned, keyed by `host:port`, since entries share one. */
  const spawned = new Map<string, ManagedProcess>();
  const probeQuestions: readonly ProbeQuestion[] = [
    { key: 'host', label: 'host', type: 'string', default: '127.0.0.1' },
    { key: 'port', label: 'port', type: 'number', default: DEFAULT_PORT },
    {
      key: 'api_key_env',
      label: 'environment variable holding the API key (blank for none)',
      type: 'string',
    },
    // No `start` question: `ollama serve` is foreground, and `ProcessExecutor.spawn`
    // is `detached: false`, so a server started from a probe would die with the
    // CLI. `startServer` is deliberately absent for the same reason.
  ];

  const bearer = (value: string | undefined): Record<string, string> =>
    value ? { authorization: `Bearer ${value}` } : {};
  const authHeaders = (runtime: RuntimeInstance): Record<string, string> =>
    bearer(resolveAuthValue(runtime.auth));
  const portOf = (runtime: RuntimeInstance): number => runtime.port ?? DEFAULT_PORT;
  const origin = (runtime: RuntimeInstance): string => `http://${runtime.host}:${portOf(runtime)}`;
  const endpointKey = (runtime: RuntimeInstance): string => `${runtime.host}:${portOf(runtime)}`;
  const versionUrl = (base: string): string => joinUrl(base, 'api/version');
  const parseName = (entry: OllamaModel): string | undefined => entry.name ?? entry.model;
  const names = (entries: readonly OllamaModel[]): string[] =>
    entries.map(parseName).filter((name): name is string => !!name);

  /** One list endpoint, two meanings: `api/tags` installed, `api/ps` resident. */
  const listing = async (runtime: RuntimeInstance, path: string): Promise<OllamaModel[]> => {
    const response = await httpJson<ModelListResponse>(joinUrl(origin(runtime), path), {
      headers: authHeaders(runtime),
      timeoutMs: 10_000,
    });
    if (response.status === 401 || response.status === 403) {
      throw gatewayError('UPSTREAM_UNAUTHORIZED', `Ollama rejected /${path} (${response.status})`, {
        details: { runtime: runtime.id, adapter: id },
      });
    }
    return response.body?.models ?? [];
  };
  const tags = async (runtime: RuntimeInstance): Promise<OllamaModel[]> =>
    await listing(runtime, 'api/tags');
  /** The residency source of truth: `/api/ps` lists only what is loaded (§17). */
  const ps = async (runtime: RuntimeInstance): Promise<OllamaModel[]> =>
    await listing(runtime, 'api/ps');

  /**
   * Ask an endpoint what it serves (§22).
   *
   * Unlike every other adapter here, the HTTP question comes *first* and the
   * executable check is the fallback. Ollama's whole lifecycle API is HTTP, so
   * a reachable server is fully drivable without the binary — a remote or
   * containerized Ollama, or one behind the authenticating proxy `auth:`
   * exists for. Refusing to look would contradict `doctor`, which already
   * reports a missing executable at `warn`, "only needed if the gateway has to
   * spawn the server". The binary only decides what to say once nothing
   * answered: `not_installed` when it is absent, `not_running` when it is there
   * and could bring a server up.
   */
  const probe = async (target: ProbeTarget): Promise<ProbeResult> => {
    const headers = bearer(target.apiKey);
    const health = await probeHealth(versionUrl(target.url), {
      headers,
      timeoutMs: target.timeoutMs ?? 3_000,
    });
    if (health.state === 'unreachable') {
      if (!(await executableAvailable(executor, binary))) {
        return {
          status: 'not_installed',
          url: target.url,
          detail: `nothing answers at ${target.url}, and ${binary} is not on PATH`,
          executable: binary,
        };
      }
      return { status: 'not_running', url: target.url, detail: health.detail };
    }
    // Running, credential required. Never reported as "not running" (§22).
    // `probeHealth` maps 401/403 to `state: 'error'`, never `'ready'`, so this
    // cannot be swallowed by the identity check below.
    if (health.httpStatus === 401 || health.httpStatus === 403) {
      return { status: 'auth_required', url: target.url, detail: `HTTP ${health.httpStatus}` };
    }
    // `/api/version` answers `{"version": "..."}` and nothing else here does, so
    // it answers "is this mine?" without this package having to know what any
    // other runtime's health endpoint looks like. The port is *taken*, which is
    // not the same as free (§22).
    if (health.state === 'ready' && !identifiesAsOllama(health.body)) {
      return {
        status: 'foreign_server',
        url: target.url,
        detail: 'a server answered /api/version, but it does not identify as Ollama',
      };
    }
    if (health.state !== 'ready') {
      return { status: 'not_running', url: target.url, detail: health.detail };
    }
    if (!(await executableAvailable(executor, binary))) {
      // Everything below still works; only `start` would not. `ProbeResult`'s
      // `running` variant carries no `detail`, and `doctor` reports the missing
      // executable in its own right, so this is said in the log and nowhere else.
      logger.warn('Ollama is answering, but its executable is not on PATH', {
        event: 'probe.not_spawnable',
        adapter: id,
        url: target.url,
        executable: binary,
      });
    }
    const [loadedResponse, availableResponse] = await Promise.all([
      httpJson<ModelListResponse>(joinUrl(target.url, 'api/ps'), {
        headers,
        timeoutMs: target.timeoutMs ?? 5_000,
      }),
      httpJson<ModelListResponse>(joinUrl(target.url, 'api/tags'), {
        headers,
        timeoutMs: target.timeoutMs ?? 5_000,
      }),
    ]);
    if (
      [loadedResponse, availableResponse].some(
        (response) => response.status === 401 || response.status === 403,
      )
    ) {
      return { status: 'auth_required', url: target.url, detail: 'HTTP 401/403' };
    }
    // Both halves go through the one normalizer, so a name cannot appear in
    // `models` and `available` under two spellings.
    const loaded = new Set(names(loadedResponse.body?.models ?? []).map(tagged));
    return {
      status: 'running',
      url: target.url,
      models: [...loaded].map((name) => ({
        id: name,
        suggestedId: suggestKeyForServedId(name),
        loaded: true,
      })),
      available: names(availableResponse.body?.models ?? [])
        .map(tagged)
        .map((name) => ({ id: name, suggestedId: suggestKeyForServedId(name) })),
    };
  };

  const identifiesAsOllama = (body: unknown): boolean =>
    !!body &&
    typeof body === 'object' &&
    typeof (body as { version?: unknown }).version === 'string';

  /**
   * Load the model and pin it (§16).
   *
   * `POST /api/generate` with no prompt is Ollama's documented load call, and it
   * blocks until the model is resident — which is what makes it the readiness
   * primitive rather than something to poll around. `keep_alive: -1` disables
   * the idle timer: residency is the gateway's decision, not a five-minute
   * default's, which is also why `OLLAMA_KEEP_ALIVE` is reserved.
   */
  const loadModel = async (runtime: RuntimeInstance): Promise<void> => {
    const response = await httpJson(joinUrl(origin(runtime), 'api/generate'), {
      method: 'POST',
      headers: { ...authHeaders(runtime), 'content-type': 'application/json' },
      body: JSON.stringify({ model: runtime.backendModel, keep_alive: -1 }),
      timeoutMs: loadTimeoutMs,
    });
    if (response.status === 404) {
      // A discovery error, distinct from a load failure.
      throw gatewayError(
        'RUNTIME_MODEL_MISMATCH',
        `Ollama does not know a model called "${runtime.backendModel}"`,
        {
          details: { runtime: runtime.id, adapter: id, model: runtime.backendModel },
          hint: 'run `ollama pull` to install the model',
        },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw gatewayError(
        'UPSTREAM_UNAUTHORIZED',
        `Ollama rejected the load request (${response.status})`,
        {
          details: { runtime: runtime.id, adapter: id },
          hint: "supply the credential through the entry's auth block",
        },
      );
    }
    if (!response.ok) {
      throw gatewayError(
        'RUNTIME_START_FAILED',
        `Ollama failed to load "${runtime.backendModel}" (HTTP ${response.status})`,
        { details: { runtime: runtime.id, adapter: id, detail: response.text.slice(0, 300) } },
      );
    }
  };

  /** The same call with `keep_alive: 0`, which is Ollama's unload (§8). */
  const unloadModel = async (runtime: RuntimeInstance, model: string): Promise<void> => {
    const response = await httpJson(joinUrl(origin(runtime), 'api/generate'), {
      method: 'POST',
      headers: { ...authHeaders(runtime), 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      timeoutMs: 60_000,
    });
    // 404 means Ollama no longer knows the model: a benign no-op during release.
    if (response.ok || response.status === 404) return;
    throw gatewayError(
      'RUNTIME_UNLOAD_FAILED',
      `Ollama failed to unload "${model}" (HTTP ${response.status})`,
      {
        details: { runtime: runtime.id, adapter: id, model, detail: response.text.slice(0, 300) },
      },
    );
  };

  /**
   * Confirm exactly what should be resident, and nothing else (§8, §16).
   *
   * Ollama auto-loads on request and holds several models at once, so "the
   * right model is loaded" is not enough — anything the gateway did not ask for
   * is a second resident model quietly sharing the GPU. `keepLoaded` names the
   * models another entry keeps resident on purpose, spelled as this runtime
   * answers to them, and widens "nothing else" to exactly those.
   *
   * Every comparison goes through `tagged`, because config and `keepLoaded` may
   * omit `:latest` while `/api/ps` never does.
   */
  const enforceSingleResident = async (
    runtime: RuntimeInstance,
    keepLoaded: readonly string[],
  ): Promise<void> => {
    const allowed = new Set([runtime.backendModel, ...keepLoaded].map(tagged));
    for (const model of names(await ps(runtime))) {
      if (allowed.has(tagged(model))) continue;
      logger.warn('unloading a stray Ollama model to keep one resident', {
        event: 'slot.enforce_single',
        adapter: id,
        runtime: runtime.id,
        stray: model,
      });
      await unloadModel(runtime, model);
    }
    const resident = names(await ps(runtime));
    const target = tagged(runtime.backendModel);
    if (!resident.some((model) => tagged(model) === target)) {
      throw gatewayError(
        'RUNTIME_MODEL_MISMATCH',
        `Ollama reports "${runtime.backendModel}" as not loaded after an explicit load`,
        { details: { runtime: runtime.id, adapter: id, served: resident } },
      );
    }
    const unexpected = resident.filter((model) => !allowed.has(tagged(model)));
    if (unexpected.length > 0) {
      throw gatewayError(
        'RUNTIME_UNLOAD_FAILED',
        `Ollama still has ${unexpected.length} unexpected model(s) resident; refusing to report ready`,
        { details: { runtime: runtime.id, adapter: id, served: resident } },
      );
    }
  };

  const start = async (runtime: RuntimeInstance, wait: WaitOptions = {}): Promise<void> => {
    // `ollama serve` takes no flags — every knob is an environment variable —
    // so there is no argv to render and `extra_args` is refused at load time.
    // It is also foreground, which is why `lrd probe --start` is unavailable.
    const managed = executor.spawn({
      command: binary,
      args: [...binaryArgs, 'serve'],
      env: serveEnv(runtime),
    });
    spawned.set(endpointKey(runtime), managed);
    const ready = waitUntilHealthy(versionUrl(origin(runtime)), {
      timeoutMs: wait.timeoutMs ?? startupTimeoutMs,
      signal: wait.signal,
    }).then(() => 'ready' as const);
    const outcome = await Promise.race([ready, managed.exited]);
    if (outcome !== 'ready') {
      const error = managed.error();
      if (error) {
        throw gatewayError('RUNTIME_START_FAILED', `could not run ${binary}: ${error.message}`, {
          details: { runtime: runtime.id, adapter: id },
          hint: 'install it, or set an absolute path via the adapter binary option',
        });
      }
      throw gatewayError(
        'RUNTIME_START_FAILED',
        `ollama serve exited during startup (code ${outcome.code ?? 'null'})`,
        {
          details: {
            runtime: runtime.id,
            adapter: id,
            detail: managed.logs().slice(-20).join('\n').slice(0, 500),
          },
        },
      );
    }
  };

  /**
   * The spawn environment (§20). Server-scoped options only take effect here,
   * which is why `doctor` warns when the gateway attaches instead.
   *
   * `OLLAMA_HOST` is written last: it is reserved, and the gateway must own the
   * endpoint it proxies to and health-checks.
   */
  const serveEnv = (runtime: RuntimeInstance): Record<string, string> => ({
    ...renderOllamaEnv(runtime.options as OllamaOptions),
    OLLAMA_HOST: `${runtime.host}:${portOf(runtime)}`,
  });

  const acquire = async (
    runtime: RuntimeInstance,
    acquireOptions: AcquireOptions = {},
  ): Promise<AcquireResult> => {
    const timeoutMs = acquireOptions.timeoutMs ?? startupTimeoutMs;
    const health = await probeHealth(versionUrl(origin(runtime)), { timeoutMs: 3_000 });
    let ownership: AcquireResult['ownership'];
    if (health.state === 'unreachable') {
      await start(runtime, { ...acquireOptions, timeoutMs });
      ownership = 'spawned';
    } else {
      // A second `ollama serve` on a healthy endpoint would fail to bind, and on
      // another port it would duplicate model memory. Never spawn alongside one.
      ownership = 'attached';
      await waitUntilHealthy(versionUrl(origin(runtime)), {
        timeoutMs,
        signal: acquireOptions.signal,
      });
    }
    await loadModel(runtime);
    await enforceSingleResident(runtime, acquireOptions.keepLoaded ?? []);
    return { ownership };
  };

  /** Unloading is enough; the server is normally the user's and stays up (§8). */
  const release = async (runtime: RuntimeInstance): Promise<void> => {
    await unloadModel(runtime, runtime.backendModel);
  };

  /** Only used on gateway shutdown for a server the gateway itself spawned. */
  const stop = async (runtime: RuntimeInstance): Promise<void> => {
    const managed = spawned.get(endpointKey(runtime));
    if (!managed) return;
    await managed.stop({ timeoutMs: 15_000 });
    spawned.delete(endpointKey(runtime));
  };

  const health = async (runtime: RuntimeInstance): Promise<HealthStatus> =>
    await probeHealth(versionUrl(origin(runtime)), { timeoutMs: 5_000 });

  const waitUntilReady = async (
    runtime: RuntimeInstance,
    wait: WaitOptions = {},
  ): Promise<void> => {
    await waitUntilHealthy(versionUrl(origin(runtime)), {
      timeoutMs: wait.timeoutMs ?? startupTimeoutMs,
      intervalMs: wait.intervalMs,
      signal: wait.signal,
    });
  };

  const listModels = async (runtime: RuntimeInstance): Promise<ModelInfo[]> => {
    const [catalogue, loaded] = await Promise.all([tags(runtime), ps(runtime)]);
    const loadedSet = new Set(names(loaded).map(tagged));
    return names(catalogue).map((name) => ({ id: name, loaded: loadedSet.has(tagged(name)) }));
  };

  /**
   * Identity and residency in one answer (§16, §17). `/api/ps` lists exactly
   * what holds memory, so "the target is there and nothing beyond `keepLoaded`
   * is" is a single pass over it. This must agree with `enforceSingleResident`,
   * or one would undo the other's answer.
   */
  const verifyIdentity = async (
    runtime: RuntimeInstance,
    context: ResidencyContext = {},
  ): Promise<IdentityCheck> => {
    const served = names(await ps(runtime));
    const allowed = new Set([runtime.backendModel, ...(context.keepLoaded ?? [])].map(tagged));
    const target = tagged(runtime.backendModel);
    const ok =
      served.some((name) => tagged(name) === target) &&
      served.every((name) => allowed.has(tagged(name)));
    return { ok, served, detail: ok ? undefined : `served=${served.join(',')}` };
  };

  /**
   * What the upstream answers to (§13). Ollama accepts the configured spelling
   * as written, so this is the raw `backend_model` — `tagged` is for comparing
   * against what `/api/ps` reports back, never for addressing the server.
   */
  const servedModelId = (runtime: RuntimeInstance): string => runtime.backendModel;

  /** OpenAI only: Ollama serves no `/v1/messages`, so it cannot fill an Anthropic role (§14). */
  const capabilities = async (_runtime: RuntimeInstance): Promise<Capabilities> => ({
    surfaces: ['openai'],
    streaming: true,
  });

  const endpoint = async (runtime: RuntimeInstance): Promise<Endpoint> => {
    const value = resolveAuthValue(runtime.auth);
    return {
      baseUrl: joinUrl(origin(runtime), 'v1'),
      ...(value ? { authHeader: { name: 'authorization', value: `Bearer ${value}` } } : {}),
    };
  };

  const declaredLimits = (runtime: RuntimeInstance): DeclaredLimits => ({
    context: (runtime.options as OllamaOptions).context_length,
  });

  const requiredExecutables = (_runtime: RuntimeInstance): string[] => [binary];

  const logs = (runtime: RuntimeInstance): string[] =>
    spawned.get(endpointKey(runtime))?.logs() ?? [];

  const validateOptions = (raw: unknown, context: OptionValidationContext): OllamaOptions =>
    validateOllamaOptions(raw, context);

  return {
    id,
    modelRelease,
    defaultProbeTarget,
    probeQuestions,
    optionSpecs: OLLAMA_OPTION_SPECS,
    reservedArgs: OLLAMA_RESERVED_ARGS,
    serverScopedOptionKeys: OLLAMA_SERVER_SCOPED_OPTION_KEYS,
    validateOptions,
    probe,
    acquire,
    release,
    start,
    stop,
    health,
    waitUntilReady,
    listModels,
    verifyIdentity,
    servedModelId,
    capabilities,
    endpoint,
    declaredLimits,
    requiredExecutables,
    logs,
    serveEnv,
  };
};
