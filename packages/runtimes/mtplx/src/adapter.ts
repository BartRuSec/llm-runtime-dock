import type {
  AcquireResult,
  Capabilities,
  DeclaredLimits,
  DiscoveredModel,
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
  waitUntilHealthy,
  waitUntilUnreachable,
} from '@llm-runtime-dock/core';
import type { MtplxOptions } from './options.js';
import {
  MTPLX_OPTION_SPECS,
  MTPLX_RESERVED_ARGS,
  renderMtplxArgs,
  validateMtplxOptions,
} from './options.js';

/**
 * MTPLX adapter (spec §18).
 *
 * MTPLX serves one model per process, so freeing the resident slot means
 * stopping the server — including one the gateway attached to rather than
 * spawned (§8). Scheduling logic lives in core; this adapter only knows how to
 * turn one entry into an MTPLX invocation and how to ask MTPLX what it serves.
 */

export interface MtplxAdapterOptions {
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
  readonly shutdownTimeoutMs?: number;
}

const DEFAULT_PORT = 8000;

/**
 * MTPLX exposes one member beyond the core contract: `serveArgs`, the spawn
 * argv, which tests assert against so launch options are known to reach the
 * command line.
 */
export interface MtplxAdapter extends RuntimeAdapter {
  serveArgs(runtime: RuntimeInstance): string[];
  declaredLimits(runtime: RuntimeInstance): DeclaredLimits;
}

export const createMtplxAdapter = (options: MtplxAdapterOptions = {}): MtplxAdapter => {
  const id = 'mtplx';
  const modelRelease = 'stop_server' as const;
  const defaultProbeTarget = `http://127.0.0.1:${DEFAULT_PORT}`;
  const optionSpecs = MTPLX_OPTION_SPECS;
  const reservedArgs = MTPLX_RESERVED_ARGS;
  /** MTPLX serves one model per process, so no option is shared between entries. */
  const serverScopedOptionKeys: readonly string[] = [];
  /** Processes this adapter spawned, keyed by entry id. */
  const spawned = new Map<string, ManagedProcess>();
  /**
   * The id `/v1/models` reported for each entry.
   *
   * MTPLX derives the served id from the loaded artifact — `--model
   * Youssofal/Qwen3.8-…` is served as `mtplx-qwen38-27b-optimized-quality` —
   * so it is learned at verification time rather than guessed from the repo id.
   * Cleared on release, or a later request would be proxied under a stale id.
   */
  const servedIds = new Map<string, string>();
  const binary = options.binary ?? process.env.LRD_MTPLX_BIN ?? 'mtplx';
  const binaryArgs = options.binaryArgs ?? [];
  const logger = options.logger ?? nullLogger;
  const executor = options.executor ?? createProcessExecutor(logger);
  const startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 15_000;

  const probeQuestions: readonly ProbeQuestion[] = [
    { key: 'host', label: 'host', type: 'string', default: '127.0.0.1' },
    { key: 'port', label: 'port', type: 'number', default: DEFAULT_PORT },
    // MTPLX takes `serve --api-key` / `--api-key-file` and reports
    // `api_key_required` on /health, so a server here really can demand one.
    {
      key: 'api_key_env',
      label: 'environment variable holding the API key (blank for none)',
      type: 'string',
    },
  ];

  const validateOptions = (raw: unknown, context: OptionValidationContext): MtplxOptions => {
    return validateMtplxOptions(raw, context);
  };

  /**
   * What can this machine serve (§22)?
   *
   * `/v1/models` alone answers "what is loaded right now", which for a
   * single-model runtime is one model when a server happens to be up and
   * nothing otherwise — useless for writing a configuration. The local pack
   * cache is the real answer, and `mtplx models --json` is the documented,
   * read-only way to read it. Probing still starts nothing.
   */
  const probe = async (target: ProbeTarget): Promise<ProbeResult> => {
    // Before anything is asked over HTTP: without the binary this adapter can
    // neither start nor drive a server, so "not installed" is the answer, and it
    // is not the same answer as "not running" (§22).
    if (!(await executableAvailable(executor, binary))) {
      return {
        status: 'not_installed',
        url: target.url,
        detail: `${binary} not found on PATH`,
        executable: binary,
      };
    }

    const available = await listInstalled();

    const health = await probeHealth(joinUrl(target.url, 'health'), {
      timeoutMs: target.timeoutMs ?? 3_000,
    });
    if (health.state === 'unreachable') {
      return { status: 'not_running', url: target.url, detail: health.detail, available };
    }
    if (health.state === 'ready' && !isMtplxHealth(health.body)) {
      // Something is on this port and it is not MTPLX. oMLX defaults to the same
      // port, so without this a probe would claim its server, and `--save` would
      // write an entry whose first switch talks to the wrong backend (§22).
      return {
        status: 'foreign_server',
        url: target.url,
        detail: 'a server answered /health, but it is not MTPLX',
      };
    }

    const headers: Record<string, string> = {};
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    const response = await httpJson<{ data?: Array<{ id?: string; context_length?: number }> }>(
      joinUrl(target.url, 'v1/models'),
      { headers, timeoutMs: target.timeoutMs ?? 5_000 },
    );
    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_required', url: target.url, detail: `HTTP ${response.status}` };
    }
    if (!response.ok || !response.body?.data) {
      return {
        status: 'not_running',
        url: target.url,
        detail: `HTTP ${response.status}`,
        available,
      };
    }
    return {
      status: 'running',
      url: target.url,
      models: response.body.data
        .filter(
          (entry): entry is { id: string; context_length?: number } => typeof entry.id === 'string',
        )
        .map((entry) => ({ id: entry.id, contextLength: entry.context_length })),
      available,
    };
  };

  /**
   * The local pack cache, via `mtplx models --json`.
   *
   * `repo_id` is what `mtplx serve --model` accepts, so it becomes
   * `backend_model`. It contains a `/`, which is not a good configuration key,
   * so a readable logical id is suggested alongside it — §22 assumed the two
   * were the same, and for a repo id they cannot be.
   */
  const listInstalled = async (): Promise<DiscoveredModel[]> => {
    let result: { code: number | null; stdout: string };
    try {
      result = await executor.run({
        command: binary,
        args: [...binaryArgs, 'models', '--json'],
        timeoutMs: 15_000,
      });
    } catch {
      // No mtplx on PATH is a normal answer here, not a probe failure.
      return [];
    }
    if (result.code !== 0) return [];

    try {
      const parsed = JSON.parse(result.stdout) as {
        models?: Array<{ repo_id?: string; validation?: { ok?: boolean } }>;
      };
      return (parsed.models ?? [])
        .filter(
          (entry): entry is { repo_id: string; validation?: { ok?: boolean } } =>
            typeof entry.repo_id === 'string',
        )
        .map((entry) => ({
          id: entry.repo_id,
          suggestedId: suggestLogicalId(entry.repo_id),
          // MTPLX validates its own cache. A model it reports without a valid
          // runtime contract cannot be served, so it is reported and skipped
          // rather than written into a configuration that would fail later.
          ...(entry.validation?.ok === false
            ? { unusable: 'MTPLX reports no valid runtime contract for this model' }
            : {}),
        }));
    } catch {
      return [];
    }
  };

  /**
   * Attach to a healthy MTPLX server on the configured port, or spawn one (§8).
   *
   * If a server answers but serves a different model, it is holding the resident
   * slot and must be stopped before the right one starts — even though the
   * gateway did not start it (§18).
   */
  const acquire = async (
    runtime: RuntimeInstance,
    options: WaitOptions = {},
  ): Promise<AcquireResult> => {
    const timeoutMs = options.timeoutMs ?? startupTimeoutMs;
    const health = await probeHealth(healthUrl(runtime), { timeoutMs: 3_000 });

    if (health.state !== 'unreachable') {
      await waitUntilHealthy(healthUrl(runtime), { timeoutMs, signal: options.signal });
      const identity = await verifyIdentity(runtime);
      if (identity.ok) {
        logger.info('attached to a running mtplx server', {
          event: 'runtime.attached',
          runtime: runtime.id,
          adapter: id,
          model: runtime.backendModel,
        });
        return { ownership: 'attached' };
      }
      logger.warn(
        `releasing foreign mtplx server on :${portOf(runtime)} to free the resident slot`,
        {
          event: 'runtime.release_foreign',
          runtime: runtime.id,
          adapter: id,
          serves: [...identity.served],
        },
      );
      await stop(runtime, options);
    }

    await start(runtime, { ...options, timeoutMs });
    return { ownership: 'spawned' };
  };

  /** For a single-model runtime, freeing the slot is stopping the server (§8). */
  const release = async (runtime: RuntimeInstance, options: WaitOptions = {}): Promise<void> => {
    await stop(runtime, options);
  };

  const start = async (runtime: RuntimeInstance, options: WaitOptions = {}): Promise<void> => {
    const args = serveArgs(runtime);
    const managed = executor.spawn({
      command: binary,
      args: [...binaryArgs, ...args],
    });
    spawned.set(runtime.id, managed);

    const timeoutMs = options.timeoutMs ?? startupTimeoutMs;
    const exited = managed.exited.then((info) => info);
    const ready = waitUntilHealthy(healthUrl(runtime), {
      timeoutMs,
      signal: options.signal,
    }).then(() => 'ready' as const);

    const outcome = await Promise.race([ready, exited]);
    if (outcome !== 'ready') {
      const logs = managed.logs().slice(-20).join('\n');
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
        `mtplx exited during startup (code ${outcome.code ?? 'null'}, signal ${outcome.signal ?? 'null'})`,
        { details: { runtime: runtime.id, adapter: id, detail: logs.slice(0, 500) } },
      );
    }
  };

  const stop = async (runtime: RuntimeInstance, options: WaitOptions = {}): Promise<void> => {
    const port = portOf(runtime);
    // The documented CLI command is the lifecycle mechanism (§10).
    try {
      await executor.run({
        command: binary,
        args: [...binaryArgs, 'stop', '--port', String(port)],
        timeoutMs: shutdownTimeoutMs,
      });
    } catch (error) {
      logger.warn('mtplx stop reported an error', {
        event: 'runtime.stop_error',
        runtime: runtime.id,
        adapter: id,
        error: (error as Error).message,
      });
    }

    const managed = spawned.get(runtime.id);
    if (managed && !managed.hasExited()) {
      await managed.stop({ timeoutMs: options.timeoutMs ?? shutdownTimeoutMs });
    }
    spawned.delete(runtime.id);
    // The next start may serve under a different id; never carry a stale one.
    servedIds.delete(runtime.id);

    const gone = await waitUntilUnreachable(healthUrl(runtime), {
      timeoutMs: options.timeoutMs ?? shutdownTimeoutMs,
    });
    if (!gone) {
      throw gatewayError(
        'RUNTIME_STOP_FAILED',
        `mtplx on :${port} is still answering after stop; the resident slot cannot be freed`,
        { details: { runtime: runtime.id, adapter: id, port } },
      );
    }
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
    const response = await httpJson<{ data?: Array<{ id?: string; context_length?: number }> }>(
      joinUrl(baseUrl(runtime), 'models'),
      { headers: await authHeaders(runtime), timeoutMs: 10_000 },
    );
    if (response.status === 401 || response.status === 403) {
      throw gatewayError(
        'UPSTREAM_UNAUTHORIZED',
        `mtplx rejected /v1/models (${response.status})`,
        {
          details: { runtime: runtime.id, adapter: id },
        },
      );
    }
    if (!response.ok || !response.body?.data) return [];
    return response.body.data
      .filter(
        (entry): entry is { id: string; context_length?: number } => typeof entry.id === 'string',
      )
      .map((entry) => ({ id: entry.id, contextLength: entry.context_length, loaded: true }));
  };

  /**
   * Source of truth for MTPLX is `/v1/models` (§17).
   *
   * One process serves exactly one model, and the served id is derived from the
   * loaded artifact rather than from `--model` — `--model-id` is reserved so it
   * cannot drift. So the check is "exactly one model is served", and that id is
   * recorded as what to proxy under. A running server with nothing loaded
   * reports none, and correctly fails here rather than looking ready.
   */
  const verifyIdentity = async (runtime: RuntimeInstance): Promise<IdentityCheck> => {
    let models: ModelInfo[];
    try {
      models = await listModels(runtime);
    } catch (error) {
      return { ok: false, served: [], detail: (error as Error).message };
    }
    const served = models.map((model) => model.id);
    if (served.length !== 1) {
      return {
        ok: false,
        served,
        detail:
          served.length === 0
            ? 'the server is running but has no model loaded'
            : `expected one served model, found ${served.length}`,
      };
    }
    servedIds.set(runtime.id, served[0] as string);
    return { ok: true, served };
  };

  /**
   * What the upstream answers to. Known only once the server has told us, so
   * before that the configured reference is the best available answer.
   */
  const servedModelId = (runtime: RuntimeInstance): string => {
    return servedIds.get(runtime.id) ?? runtime.backendModel;
  };

  const capabilities = async (_runtime: RuntimeInstance): Promise<Capabilities> => {
    // MTPLX serves /v1/messages and /v1/messages/count_tokens alongside chat
    // completions, so both surfaces are proxied without translation (§14).
    return { surfaces: ['openai', 'anthropic'], streaming: true };
  };

  const endpoint = async (runtime: RuntimeInstance): Promise<Endpoint> => {
    const value = resolveAuthValue(runtime.auth);
    return {
      baseUrl: baseUrl(runtime),
      ...(value ? { authHeader: { name: 'authorization', value: `Bearer ${value}` } } : {}),
    };
  };

  const declaredLimits = (runtime: RuntimeInstance): DeclaredLimits => {
    const options = runtime.options as MtplxOptions;
    return { context: options.context_window, output: options.max_tokens };
  };

  const requiredExecutables = (_runtime: RuntimeInstance): string[] => {
    return [binary];
  };

  const logs = (runtime: RuntimeInstance): string[] => {
    return spawned.get(runtime.id)?.logs() ?? [];
  };

  /**
   * The launch argv (§18). Built from configuration only: nothing derived from
   * an HTTP request can reach this array.
   */
  const serveArgs = (runtime: RuntimeInstance): string[] => {
    return [
      'serve',
      '--model',
      runtime.backendModel,
      '--host',
      runtime.host,
      '--port',
      String(portOf(runtime)),
      ...renderMtplxArgs(runtime.options as MtplxOptions),
      ...runtime.extraArgs,
    ];
  };

  const portOf = (runtime: RuntimeInstance): number => {
    return runtime.port ?? DEFAULT_PORT;
  };

  const origin = (runtime: RuntimeInstance): string => {
    return `http://${runtime.host}:${portOf(runtime)}`;
  };

  const healthUrl = (runtime: RuntimeInstance): string => {
    return joinUrl(origin(runtime), 'health');
  };

  const baseUrl = (runtime: RuntimeInstance): string => {
    return joinUrl(origin(runtime), 'v1');
  };

  const authHeaders = async (runtime: RuntimeInstance): Promise<Record<string, string>> => {
    const value = resolveAuthValue(runtime.auth);
    return value ? { authorization: `Bearer ${value}` } : {};
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
    declaredLimits,
    requiredExecutables,
    logs,
    serveArgs,
  };
};

/**
 * Does this `/health` body come from MTPLX (§22)?
 *
 * MTPLX answers with its launch descriptor — the model it loaded, the backend
 * that serves it, the profile it runs under. Two structural fields are checked
 * rather than one cosmetic one, and only on a `ready` health: a server still
 * loading answers 503 with a short status body, which is ours and must not be
 * mistaken for somebody else's.
 */
const isMtplxHealth = (body: unknown): boolean => {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (typeof record.generation_mode === 'string') return true;
  if (typeof record.runtime_mode === 'string') return true;
  const startup = record.startup;
  if (startup && typeof startup === 'object') {
    const backend = (startup as Record<string, unknown>).backend;
    if (backend && typeof backend === 'object') {
      return typeof (backend as Record<string, unknown>).backend_id === 'string';
    }
  }
  return false;
};

/**
 * A readable configuration key for a repo id.
 *
 * `Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality` → `qwen3.8-27b-mtplx-optimized-quality`.
 * This only names the entry a human is about to review; it is never matched
 * against anything the runtime reports, so it is safe to derive. The id MTPLX
 * actually serves under is learned from `/v1/models`, never guessed.
 */
export const suggestLogicalId = (repoId: string): string => {
  const name = repoId.split('/').pop() ?? repoId;
  return (
    name
      //  .replace(/[-_]?MTPLX[-_]?/gi, '-')
      .replace(/[^A-Za-z0-9._+@:-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase() || name.toLowerCase()
  );
};
