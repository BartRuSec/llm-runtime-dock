import type {
  AcquireOptions,
  AcquireResult,
  Capabilities,
  Endpoint,
  HealthStatus,
  IdentityCheck,
  Logger,
  ManagedProcess,
  ModelInfo,
  OptionValidationContext,
  ProbeQuestion,
  ProbeResult,
  ResidencyContext,
  ProbeStartResult,
  ProbeStartTarget,
  ProbeTarget,
  ProcessExecutor,
  RuntimeAdapter,
  RuntimeInstance,
  WaitOptions,
} from '@llm-runtime-dock/core';
import {
  cliError,
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
import type { OmlxOptions } from './options.js';
import {
  OMLX_OPTION_SPECS,
  OMLX_RESERVED_ARGS,
  OMLX_SERVER_SCOPED_OPTION_KEYS,
  renderOmlxArgs,
  validateOmlxOptions,
} from './options.js';

/**
 * oMLX adapter (spec §20).
 *
 * Two things shape this adapter. Its CLI manages the *server* only — there is no
 * `omlx load`/`omlx unload`, so the documented HTTP endpoints are the lifecycle
 * mechanism rather than a shortcut around one (§10). And it loads models by
 * itself on request, with LRU eviction, so the gateway must drive residency
 * explicitly and confirm exactly one model is resident before reporting ready.
 */

export interface OmlxAdapterOptions {
  /** Executable name or path. */
  readonly binary?: string;
  /**
   * Arguments placed before the runtime's own, for when the executable is a
   * launcher rather than the tool itself — `node script.mjs`, `uvx mtplx`. A
   * shebang script is not directly executable on Windows, so this is how a
   * script-based command stays portable.
   */
  readonly binaryArgs?: readonly string[];
  readonly executor?: ProcessExecutor;
  readonly logger?: Logger;
  readonly startupTimeoutMs?: number;
  readonly loadTimeoutMs?: number;
}

interface ModelStatusEntry {
  readonly id?: string;
  readonly loaded?: boolean;
  readonly pinned?: boolean;
}

/**
 * `GET /v1/models/status` names its array `models` — *not* `data`. Only
 * `/v1/models`, the OpenAI-shaped discovery endpoint, uses `data`, and reading
 * that key here finds nothing, which reads as "no model is loaded" and fails
 * every acquire with `RUNTIME_MODEL_MISMATCH` (§17, §20).
 */
interface ModelStatusResponse {
  readonly models?: ModelStatusEntry[];
  readonly loaded_count?: number;
}

const DEFAULT_PORT = 8000;

/**
 * oMLX exposes `serveArgs` beyond the core contract: the spawn argv, which tests
 * assert against so server-scoped options are known to reach the command line.
 */
export interface OmlxAdapter extends RuntimeAdapter {
  serveArgs(runtime: RuntimeInstance): string[];
}

export const createOmlxAdapter = (options: OmlxAdapterOptions = {}): OmlxAdapter => {
  const id = 'omlx';
  const modelRelease = 'unload_model' as const;
  const defaultProbeTarget = `http://127.0.0.1:${DEFAULT_PORT}`;
  const optionSpecs = OMLX_OPTION_SPECS;
  const reservedArgs = OMLX_RESERVED_ARGS;
  const serverScopedOptionKeys = OMLX_SERVER_SCOPED_OPTION_KEYS;
  /** Servers this adapter spawned, keyed by `host:port`, since entries share one. */
  const spawned = new Map<string, ManagedProcess>();
  const binary = options.binary ?? process.env.LRD_OMLX_BIN ?? 'omlx';
  const binaryArgs = options.binaryArgs ?? [];
  const logger = options.logger ?? nullLogger;
  const executor = options.executor ?? createProcessExecutor(logger);
  const startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 300_000;

  const probeQuestions: readonly ProbeQuestion[] = [
    { key: 'host', label: 'host', type: 'string', default: '127.0.0.1' },
    { key: 'port', label: 'port', type: 'number', default: DEFAULT_PORT },
    {
      key: 'api_key_env',
      label: 'environment variable holding the API key (blank for none)',
      type: 'string',
    },
    // oMLX loses nothing when its server is down: unlike MTPLX it reports no
    // installed catalogue, so a probe of a stopped oMLX finds nothing at all.
    {
      key: 'start',
      label: 'start the oMLX server if it is not running?',
      type: 'confirm',
      default: false,
    },
  ];

  const validateOptions = (raw: unknown, context: OptionValidationContext): OmlxOptions => {
    return validateOmlxOptions(raw, context);
  };

  /** `/health` never requires a credential; `/v1/models` may (§20, §22). */
  const probe = async (target: ProbeTarget): Promise<ProbeResult> => {
    // Without the binary this adapter can neither start nor drive a server, so
    // nothing is asked over HTTP (§22).
    if (!(await executableAvailable(executor, binary))) {
      return {
        status: 'not_installed',
        url: target.url,
        detail: `${binary} not found on PATH`,
        executable: binary,
      };
    }

    const health = await probeHealth(joinUrl(target.url, 'health'), {
      timeoutMs: target.timeoutMs ?? 3_000,
    });
    if (health.state === 'unreachable') {
      return { status: 'not_running', url: target.url, detail: health.detail };
    }
    if (health.state === 'ready' && !(await servesOmlxStatus(target))) {
      // MTPLX defaults to the same port. `/v1/models/status` is oMLX's own
      // residency endpoint (§17) and nothing else here serves it, so it answers
      // "is this mine?" positively, without this package having to know what any
      // other runtime's `/health` looks like.
      return {
        status: 'foreign_server',
        url: target.url,
        detail: 'a server answered /health, but it does not serve oMLX /v1/models/status',
      };
    }
    const headers: Record<string, string> = {};
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    const response = await httpJson<{
      data?: Array<{ id?: string; max_model_len?: number; context_length?: number }>;
    }>(joinUrl(target.url, 'v1/models'), { headers, timeoutMs: target.timeoutMs ?? 5_000 });
    if (response.status === 401 || response.status === 403) {
      // Running, credential required. Never reported as "not running" (§22).
      return { status: 'auth_required', url: target.url, detail: `HTTP ${response.status}` };
    }
    if (!response.ok || !response.body?.data) {
      return { status: 'not_running', url: target.url, detail: `HTTP ${response.status}` };
    }
    return {
      status: 'running',
      url: target.url,
      models: response.body.data
        .filter(
          (entry): entry is { id: string; max_model_len?: number; context_length?: number } =>
            typeof entry.id === 'string',
        )
        .map((entry) => ({
          id: entry.id,
          suggestedId: suggestKeyForServedId(entry.id),
          // oMLX spells the context window `max_model_len`; `context_length` is
          // the OpenAI-conventional name, kept as a fallback.
          contextLength: entry.max_model_len ?? entry.context_length,
        })),
    };
  };

  const acquire = async (
    runtime: RuntimeInstance,
    options: AcquireOptions = {},
  ): Promise<AcquireResult> => {
    const timeoutMs = options.timeoutMs ?? startupTimeoutMs;
    const health = await probeHealth(healthUrl(runtime), { timeoutMs: 3_000 });
    let ownership: AcquireResult['ownership'];

    if (health.state === 'unreachable') {
      await start(runtime, { ...options, timeoutMs });
      ownership = 'spawned';
    } else {
      // A second server would duplicate model memory and fight the first one's
      // memory guard, so never spawn alongside a healthy one (§20).
      ownership = 'attached';
      await waitUntilHealthy(healthUrl(runtime), { timeoutMs, signal: options.signal });
    }

    await loadModel(runtime);
    await enforceSingleResident(runtime, options.keepLoaded ?? []);
    return { ownership };
  };

  /** Unloading is enough; the server is normally the user's and stays up (§20). */
  const release = async (runtime: RuntimeInstance): Promise<void> => {
    await unloadModel(runtime, runtime.backendModel);
  };

  const start = async (runtime: RuntimeInstance, options: WaitOptions = {}): Promise<void> => {
    // `omlx start/stop/restart` drive the macOS app's background server, which
    // takes host/port from oMLX's own settings. `omlx serve` accepts them, and
    // the gateway must own its endpoint.
    const args = serveArgs(runtime);
    const managed = executor.spawn({
      command: binary,
      args: [...binaryArgs, ...args],
    });
    spawned.set(endpointKey(runtime), managed);

    const ready = waitUntilHealthy(healthUrl(runtime), {
      timeoutMs: options.timeoutMs ?? startupTimeoutMs,
      signal: options.signal,
    }).then(() => 'ready' as const);
    const outcome = await Promise.race([ready, managed.exited]);
    if (outcome !== 'ready') {
      const spawnError = managed.error();
      if (spawnError) {
        throw gatewayError(
          'RUNTIME_START_FAILED',
          `could not run ${binary}: ${spawnError.message}`,
          {
            details: { runtime: runtime.id, adapter: id },
            hint: 'install it, or set an absolute path via the adapter binary option',
          },
        );
      }
      throw gatewayError(
        'RUNTIME_START_FAILED',
        `omlx serve exited during startup (code ${outcome.code ?? 'null'})`,
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

  /** Only used on gateway shutdown for a server the gateway itself spawned. */
  const stop = async (runtime: RuntimeInstance): Promise<void> => {
    const key = endpointKey(runtime);
    const managed = spawned.get(key);
    if (!managed) return;
    await managed.stop({ timeoutMs: 15_000 });
    spawned.delete(key);
  };

  const health = async (runtime: RuntimeInstance): Promise<HealthStatus> => {
    return await probeHealth(healthUrl(runtime), { timeoutMs: 5_000 });
  };

  const waitUntilReady = async (
    runtime: RuntimeInstance,
    options: WaitOptions = {},
  ): Promise<void> => {
    await waitUntilHealthy(healthUrl(runtime), {
      timeoutMs: options.timeoutMs ?? startupTimeoutMs,
      intervalMs: options.intervalMs,
      signal: options.signal,
    });
  };

  const listModels = async (runtime: RuntimeInstance): Promise<ModelInfo[]> => {
    const status = await modelStatus(runtime);
    return status.models.map((entry) => ({
      id: entry.id ?? '',
      loaded: entry.loaded === true,
      pinned: entry.pinned === true,
    }));
  };

  /**
   * Bring the managed oMLX server up from a probe (§22).
   *
   * `omlx start` is daemon-style — it returns once the background server is
   * healthy — which is what makes it usable here at all, unlike a foreground
   * `serve`.
   *
   * It takes no `--port`: oMLX starts on whatever its own settings say, and this
   * adapter must not read that file (§10). There is therefore nothing to read
   * the port back from, so the endpoint asked for is the one reported — and
   * checked, because reporting an address nothing answers on would turn a server
   * that started fine into a confusing "not running".
   */
  const startServer = async (target: ProbeStartTarget): Promise<ProbeStartResult> => {
    const result = await executor.run({
      command: binary,
      args: [...binaryArgs, 'start'],
      timeoutMs: target.timeoutMs ?? startupTimeoutMs,
    });
    if (result.code !== 0) {
      throw cliError('CONFIG_INVALID', `omlx start failed (exit ${result.code})`, {
        details: { adapter: id, detail: result.stderr.slice(0, 300) },
      });
    }
    const url = `http://${target.host}:${target.port ?? DEFAULT_PORT}`;
    const health = await probeHealth(joinUrl(url, 'health'), { timeoutMs: 5_000 });
    if (health.state === 'unreachable') {
      throw cliError('CONFIG_INVALID', `oMLX started, but nothing answers at ${url}`, {
        details: { adapter: id, url },
        hint: `omlx start takes its port from oMLX's own settings, which the gateway does not read — check them and set the runtime's port: to match`,
      });
    }
    return { url };
  };

  /**
   * Does this endpoint serve oMLX's residency API (§22)?
   *
   * Only a 404 — the path is not served at all — says "not oMLX". Everything
   * else is treated as ours, deliberately: a credential rejection means a server
   * is there and wants a key, which the probe reports as `auth_required` a
   * moment later, and a 500 or a timeout says a server is struggling, not that
   * it belongs to somebody else. Unlike MTPLX, which reads a `/health` body it
   * already fetched, this is a second request with its own failure modes, and
   * the moment they fire — a loaded server under memory pressure — is the worst
   * possible moment to disown it.
   */
  const servesOmlxStatus = async (target: ProbeTarget): Promise<boolean> => {
    const headers: Record<string, string> = {};
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    try {
      const response = await httpJson(joinUrl(target.url, 'v1/models/status'), {
        headers,
        timeoutMs: target.timeoutMs ?? 3_000,
      });
      return response.status !== 404;
    } catch {
      return true;
    }
  };

  /** `/v1/models` for discovery, `/v1/models/status` for residency (§17). */
  /**
   * Identity and residency in one answer (§16, §17): oMLX auto-loads on request,
   * so "the right model is loaded" is not enough — anything the gateway did not
   * ask for is a second resident model. `keepLoaded` names the entries another
   * config entry keeps resident on purpose, which are expected rather than
   * stray.
   */
  const verifyIdentity = async (
    runtime: RuntimeInstance,
    options: ResidencyContext = {},
  ): Promise<IdentityCheck> => {
    const allowed = new Set([runtime.backendModel, ...(options.keepLoaded ?? [])]);
    const status = await modelStatus(runtime);
    const resident = status.models
      .filter((entry) => entry.loaded === true)
      .map((entry) => entry.id ?? '');
    const ok =
      resident.includes(runtime.backendModel) && resident.every((entry) => allowed.has(entry));
    return {
      ok,
      served: resident,
      detail: ok ? undefined : `loaded_count=${status.loadedCount}`,
    };
  };

  const servedModelId = (runtime: RuntimeInstance): string => {
    return runtime.backendModel;
  };

  const capabilities = async (_runtime: RuntimeInstance): Promise<Capabilities> => {
    return { surfaces: ['openai', 'anthropic'], streaming: true };
  };

  const endpoint = async (runtime: RuntimeInstance): Promise<Endpoint> => {
    const value = resolveAuthValue(runtime.auth);
    return {
      baseUrl: joinUrl(origin(runtime), 'v1'),
      ...(value ? { authHeader: { name: 'authorization', value: `Bearer ${value}` } } : {}),
    };
  };

  const requiredExecutables = (_runtime: RuntimeInstance): string[] => {
    return [binary];
  };

  const logs = (runtime: RuntimeInstance): string[] => {
    return spawned.get(endpointKey(runtime))?.logs() ?? [];
  };

  /** The spawn argv (§20). Server-scoped options only take effect here. */
  const serveArgs = (runtime: RuntimeInstance): string[] => {
    return [
      'serve',
      '--host',
      runtime.host,
      '--port',
      String(port(runtime)),
      ...renderOmlxArgs(runtime.options as OmlxOptions),
      ...runtime.extraArgs,
    ];
  };

  /**
   * `POST /v1/models/{id}/load` blocks until loading completes, so it is the
   * readiness primitive rather than something to poll around (§20).
   */
  const loadModel = async (runtime: RuntimeInstance): Promise<void> => {
    const url = joinUrl(
      origin(runtime),
      `v1/models/${encodeURIComponent(runtime.backendModel)}/load`,
    );
    const response = await httpJson<unknown>(url, {
      method: 'POST',
      headers: authHeaders(runtime),
      timeoutMs: loadTimeoutMs,
    });
    if (response.status === 404) {
      // A discovery error, distinct from a load failure.
      throw gatewayError(
        'RUNTIME_MODEL_MISMATCH',
        `oMLX does not know a model called "${runtime.backendModel}"`,
        {
          details: { runtime: runtime.id, adapter: id, model: runtime.backendModel },
          hint: 'run `lrd probe omlx` to see what the server actually serves',
        },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw gatewayError(
        'UPSTREAM_UNAUTHORIZED',
        `oMLX rejected the load request (${response.status})`,
        {
          details: { runtime: runtime.id, adapter: id },
          hint: "supply the credential through the entry's auth block",
        },
      );
    }
    if (!response.ok) {
      throw gatewayError(
        'RUNTIME_START_FAILED',
        `oMLX failed to load "${runtime.backendModel}" (HTTP ${response.status})`,
        { details: { runtime: runtime.id, adapter: id, detail: response.text.slice(0, 300) } },
      );
    }
  };

  const unloadModel = async (runtime: RuntimeInstance, modelId: string): Promise<void> => {
    const url = joinUrl(origin(runtime), `v1/models/${encodeURIComponent(modelId)}/unload`);
    const response = await httpJson<unknown>(url, {
      method: 'POST',
      headers: authHeaders(runtime),
      timeoutMs: 60_000,
    });
    // 400 means the model was not loaded: a benign no-op during release (§20).
    if (response.ok || response.status === 400 || response.status === 404) return;
    if (response.status === 409) {
      throw gatewayError(
        'RUNTIME_MODEL_PINNED',
        `oMLX model "${modelId}" is pinned and cannot be evicted, so the resident slot cannot be freed`,
        {
          details: { runtime: runtime.id, adapter: id, model: modelId },
          hint: `unpin "${modelId}" in oMLX before switching models`,
        },
      );
    }
    throw gatewayError(
      'RUNTIME_UNLOAD_FAILED',
      `oMLX failed to unload "${modelId}" (HTTP ${response.status})`,
      {
        details: { runtime: runtime.id, adapter: id, detail: response.text.slice(0, 300) },
      },
    );
  };

  /**
   * Because oMLX auto-loads on request and evicts by LRU, it can hold several
   * models. That would break §8 quietly, so residency is confirmed explicitly:
   * the target loaded, nothing else resident, strays unloaded.
   *
   * `keepLoaded` widens "nothing else" to the models another entry is keeping
   * resident on this same server (§8) — an explicit opt-in, so a model in that
   * set is expected rather than stray. A model oMLX itself marks `pinned` is
   * still a hard failure outside the set: the gateway cannot evict it and will
   * not report ready leaving two models resident by accident. Inside the set
   * that pin agrees with the configuration rather than fighting it (§20).
   */
  const enforceSingleResident = async (
    runtime: RuntimeInstance,
    keepLoaded: readonly string[],
  ): Promise<void> => {
    const allowed = new Set([runtime.backendModel, ...keepLoaded]);
    let status = await modelStatus(runtime);
    const strays = status.models.filter(
      (entry) => entry.loaded === true && !allowed.has(entry.id ?? ''),
    );

    for (const stray of strays) {
      if (stray.pinned === true) {
        throw gatewayError(
          'RUNTIME_MODEL_PINNED',
          `oMLX model "${stray.id}" is pinned and holds memory alongside "${runtime.backendModel}"`,
          {
            details: { runtime: runtime.id, adapter: id, model: stray.id ?? '' },
            hint: `unpin "${stray.id}" in oMLX, or give its entry keep_resident: true; the gateway will not leave a model resident by accident`,
          },
        );
      }
      logger.warn('unloading a stray oMLX model to keep one resident', {
        event: 'slot.enforce_single',
        adapter: id,
        runtime: runtime.id,
        stray: stray.id ?? '',
      });
      await unloadModel(runtime, stray.id ?? '');
    }

    status = await modelStatus(runtime);
    const resident = status.models
      .filter((entry) => entry.loaded === true)
      .map((entry) => entry.id ?? '');
    if (!resident.includes(runtime.backendModel)) {
      throw gatewayError(
        'RUNTIME_MODEL_MISMATCH',
        `oMLX reports "${runtime.backendModel}" as not loaded after an explicit load`,
        { details: { runtime: runtime.id, adapter: id, served: resident } },
      );
    }
    const unexpected = resident.filter((entry) => !allowed.has(entry));
    if (unexpected.length > 0) {
      throw gatewayError(
        'RUNTIME_UNLOAD_FAILED',
        `oMLX still has ${unexpected.length} unexpected model(s) resident; refusing to report ready`,
        { details: { runtime: runtime.id, adapter: id, served: resident } },
      );
    }
  };

  const modelStatus = async (
    runtime: RuntimeInstance,
  ): Promise<{ models: ModelStatusEntry[]; loadedCount: number }> => {
    const response = await httpJson<ModelStatusResponse>(
      joinUrl(origin(runtime), 'v1/models/status'),
      { headers: authHeaders(runtime), timeoutMs: 10_000 },
    );
    if (response.status === 401 || response.status === 403) {
      throw gatewayError(
        'UPSTREAM_UNAUTHORIZED',
        `oMLX rejected /v1/models/status (${response.status})`,
        {
          details: { runtime: runtime.id, adapter: id },
        },
      );
    }
    const models = response.body?.models ?? [];
    return {
      models,
      loadedCount:
        response.body?.loaded_count ?? models.filter((entry) => entry.loaded === true).length,
    };
  };

  const authHeaders = (runtime: RuntimeInstance): Record<string, string> => {
    const value = resolveAuthValue(runtime.auth);
    return value ? { authorization: `Bearer ${value}` } : {};
  };

  const port = (runtime: RuntimeInstance): number => {
    return runtime.port ?? DEFAULT_PORT;
  };

  const origin = (runtime: RuntimeInstance): string => {
    return `http://${runtime.host}:${port(runtime)}`;
  };

  const endpointKey = (runtime: RuntimeInstance): string => {
    return `${runtime.host}:${port(runtime)}`;
  };

  const healthUrl = (runtime: RuntimeInstance): string => {
    return joinUrl(origin(runtime), 'health');
  };

  return {
    id,
    modelRelease,
    defaultProbeTarget,
    probeQuestions,
    optionSpecs,
    reservedArgs,
    serverScopedOptionKeys,
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
    startServer,
    requiredExecutables,
    logs,
    serveArgs,
  };
};
