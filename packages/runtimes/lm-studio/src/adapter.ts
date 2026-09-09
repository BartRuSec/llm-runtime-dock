import type {
  AcquireOptions,
  AcquireResult,
  Capabilities,
  DeclaredLimits,
  Endpoint,
  HealthStatus,
  IdentityCheck,
  Logger,
  ModelInfo,
  OptionValidationContext,
  ProbeQuestion,
  ProbeResult,
  ProbeStartResult,
  ProbeStartTarget,
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
  suggestKeyForServedId,
  waitUntilHealthy,
} from '@llm-runtime-dock/core';
import type { LmStudioOptions } from './options.js';
import {
  LM_STUDIO_OPTION_SPECS,
  LM_STUDIO_RESERVED_ARGS,
  renderLmStudioArgs,
  validateLmStudioOptions,
} from './options.js';

/**
 * LM Studio adapter (spec §19).
 *
 * LM Studio's CLI separates server lifecycle from model lifecycle: `lms server
 * start` runs one shared server, and models are loaded into and unloaded from
 * it. Freeing the resident slot is `lms unload`; the server keeps running,
 * because the gateway does not exclusively own it.
 */

export interface LmStudioAdapterOptions {
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
  readonly commandTimeoutMs?: number;
}

interface ServerStatus {
  readonly running: boolean;
  readonly port: number | null;
}

interface PsEntry {
  readonly identifier?: string;
  readonly modelKey?: string;
}

const DEFAULT_PORT = 1234;

/**
 * LM Studio exposes `loadArgs` beyond the core contract: the `lms load` argv,
 * which tests assert against so the gateway-assigned identifier is known to
 * reach the command line.
 */
export interface LmStudioAdapter extends RuntimeAdapter {
  loadArgs(runtime: RuntimeInstance): string[];
  declaredLimits(runtime: RuntimeInstance): DeclaredLimits;
}

export const createLmStudioAdapter = (options: LmStudioAdapterOptions = {}): LmStudioAdapter => {
  const id = 'lm-studio';
  const modelRelease = 'unload_model' as const;
  const defaultProbeTarget = `http://127.0.0.1:${DEFAULT_PORT}`;
  const optionSpecs = LM_STUDIO_OPTION_SPECS;
  const reservedArgs = LM_STUDIO_RESERVED_ARGS;
  /** The bind address is server-scoped; it is a field, not an option, so nothing here. */
  const serverScopedOptionKeys: readonly string[] = [];
  const binary = options.binary ?? process.env.LRD_LMS_BIN ?? 'lms';
  const binaryArgs = options.binaryArgs ?? [];
  const logger = options.logger ?? nullLogger;
  const executor = options.executor ?? createProcessExecutor(logger);
  const startupTimeoutMs = options.startupTimeoutMs ?? 180_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;

  const probeQuestions: readonly ProbeQuestion[] = [
    { key: 'host', label: 'host', type: 'string', default: '127.0.0.1' },
    { key: 'port', label: 'port', type: 'number', default: DEFAULT_PORT },
    // `probe()` below answers `auth_required` on a 401, so this is the question
    // that lets an interactive run supply what the server asked for.
    {
      key: 'api_key_env',
      label: 'environment variable holding the API key (blank for none)',
      type: 'string',
    },
    {
      key: 'start',
      label: 'start the LM Studio server if it is not running?',
      type: 'confirm',
      default: false,
    },
  ];

  const validateOptions = (raw: unknown, context: OptionValidationContext): LmStudioOptions => {
    return validateLmStudioOptions(raw, context);
  };

  const probe = async (target: ProbeTarget): Promise<ProbeResult> => {
    // Without `lms` this adapter can neither start the server nor load a model,
    // so nothing is asked over HTTP (§22).
    if (!(await executableAvailable(executor, binary))) {
      return {
        status: 'not_installed',
        url: target.url,
        detail: `${binary} not found on PATH`,
        executable: binary,
      };
    }

    const health = await probeHealth(joinUrl(target.url, 'v1/models'), {
      timeoutMs: target.timeoutMs ?? 3_000,
    });
    if (health.state === 'unreachable') {
      return { status: 'not_running', url: target.url, detail: health.detail };
    }
    const headers: Record<string, string> = {};
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    const response = await httpJson<{ data?: Array<{ id?: string }> }>(
      joinUrl(target.url, 'v1/models'),
      { headers, timeoutMs: target.timeoutMs ?? 5_000 },
    );
    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_required', url: target.url, detail: `HTTP ${response.status}` };
    }
    if (!response.ok || !response.body?.data) {
      return { status: 'not_running', url: target.url, detail: `HTTP ${response.status}` };
    }
    return {
      status: 'running',
      url: target.url,
      models: response.body.data
        .filter((entry): entry is { id: string } => typeof entry.id === 'string')
        .map((entry) => ({ id: entry.id, suggestedId: suggestKeyForServedId(entry.id) })),
    };
  };

  /**
   * Attach to the running LM Studio server or start one, then load this entry's
   * model into it (§19).
   *
   * `lms server start --port` only decides the port when no server is running;
   * otherwise LM Studio reuses the port from its last start. A server answering
   * on a different port is therefore an error, never an invitation to spawn.
   */
  const acquire = async (
    runtime: RuntimeInstance,
    options: AcquireOptions = {},
  ): Promise<AcquireResult> => {
    const configuredPort = port(runtime);
    const status = await serverStatus();
    let ownership: AcquireResult['ownership'];

    if (!status.running) {
      await run(['server', 'start', '--port', String(configuredPort)]);
      ownership = 'spawned';
    } else if (status.port === configuredPort) {
      ownership = 'attached';
    } else {
      throw gatewayError(
        'RUNTIME_START_FAILED',
        `LM Studio is already serving on port ${status.port ?? 'unknown'}, but "${runtime.id}" is configured for port ${configuredPort}`,
        {
          details: {
            runtime: runtime.id,
            adapter: id,
            running: status.port ?? 0,
            configured: configuredPort,
          },
          hint: `set models.${runtime.id}.port to ${status.port ?? 'the running port'}, or stop LM Studio's server and let the gateway start it`,
        },
      );
    }

    await waitUntilHealthy(modelsUrl(runtime), {
      timeoutMs: options.timeoutMs ?? startupTimeoutMs,
      signal: options.signal,
    });

    // The gateway assigns the identifier so identity verification has a stable
    // answer; `--identifier` is reserved in config for exactly that reason.
    await run([
      'load',
      runtime.backendModel,
      '--identifier',
      servedModelId(runtime),
      ...renderLmStudioArgs(runtime.options as LmStudioOptions),
      ...runtime.extraArgs,
      '--yes',
    ]);

    await enforceSingleResident(runtime, options.keepLoaded ?? []);
    return { ownership };
  };

  /** Freeing the slot is `lms unload`. The server stays up (§19). */
  const release = async (runtime: RuntimeInstance): Promise<void> => {
    const result = await run(['unload', servedModelId(runtime)], { allowFailure: true });
    if (result.code !== 0) {
      // Unloading something already gone is benign; anything else is not.
      const loaded = await loadedIdentifiers();
      if (loaded.includes(servedModelId(runtime))) {
        throw gatewayError(
          'RUNTIME_UNLOAD_FAILED',
          `lms unload ${servedModelId(runtime)} failed and the model is still resident`,
          {
            details: { runtime: runtime.id, adapter: id, detail: result.stderr.slice(0, 300) },
          },
        );
      }
    }
  };

  const start = async (runtime: RuntimeInstance): Promise<void> => {
    const status = await serverStatus();
    if (status.running) return;
    await run(['server', 'start', '--port', String(port(runtime))]);
  };

  /**
   * Not supported on purpose.
   *
   * `lms server stop` would take down a server the gateway does not exclusively
   * own, and it is not part of any switch (§19). Freeing the slot is `release`,
   * which unloads the model. The limitation is represented rather than faked.
   */
  const stop = async (runtime: RuntimeInstance): Promise<void> => {
    throw gatewayError(
      'RUNTIME_STOP_FAILED',
      'the gateway does not stop the LM Studio server: it is shared, and freeing the resident slot is `lms unload`',
      {
        details: { runtime: runtime.id, adapter: id },
        hint: 'run `lms server stop` yourself if you really want the server down',
      },
    );
  };

  const health = async (runtime: RuntimeInstance): Promise<HealthStatus> => {
    return await probeHealth(modelsUrl(runtime), { timeoutMs: 5_000 });
  };

  const waitUntilReady = async (
    runtime: RuntimeInstance,
    options: WaitOptions = {},
  ): Promise<void> => {
    await waitUntilHealthy(modelsUrl(runtime), {
      timeoutMs: options.timeoutMs ?? startupTimeoutMs,
      intervalMs: options.intervalMs,
      signal: options.signal,
    });
  };

  /** What is loaded right now, per `lms ps --json` (§17). */
  const listModels = async (_runtime: RuntimeInstance): Promise<ModelInfo[]> => {
    return (await ps()).map((entry) => ({
      id: entry.identifier ?? entry.modelKey ?? '',
      loaded: true,
    }));
  };

  const verifyIdentity = async (runtime: RuntimeInstance): Promise<IdentityCheck> => {
    const served = await loadedIdentifiers();
    return { ok: served.includes(servedModelId(runtime)), served };
  };

  /** The gateway-assigned `--identifier`, which is also what the API serves under. */
  const servedModelId = (runtime: RuntimeInstance): string => {
    return runtime.id;
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

  const declaredLimits = (runtime: RuntimeInstance): DeclaredLimits => {
    const options = runtime.options as LmStudioOptions;
    return { context: options.context_length };
  };

  const requiredExecutables = (_runtime: RuntimeInstance): string[] => {
    return [binary];
  };

  /** `lms load` argv, for tests and `doctor`. */
  const loadArgs = (runtime: RuntimeInstance): string[] => {
    return [
      'load',
      runtime.backendModel,
      '--identifier',
      servedModelId(runtime),
      ...renderLmStudioArgs(runtime.options as LmStudioOptions),
      ...runtime.extraArgs,
      '--yes',
    ];
  };

  /**
   * LM Studio can hold several models at once, which would break the
   * one-resident invariant quietly (§16). Anything else loaded is unloaded
   * before readiness is reported.
   *
   * `keepLoaded` is the one exception: identifiers another entry is keeping
   * resident on this same server (§8). Unloading those would defeat the flag
   * through the very mechanism meant to protect the memory it guards.
   */
  const enforceSingleResident = async (
    runtime: RuntimeInstance,
    keepLoaded: readonly string[],
  ): Promise<void> => {
    const allowed = new Set([servedModelId(runtime), ...keepLoaded]);
    for (const identifier of await loadedIdentifiers()) {
      if (allowed.has(identifier) || identifier === '') continue;
      logger.warn('unloading a stray LM Studio model to keep one resident', {
        event: 'slot.enforce_single',
        adapter: id,
        runtime: runtime.id,
        stray: identifier,
      });
      await run(['unload', identifier], { allowFailure: true });
    }
    const remaining = (await loadedIdentifiers()).filter(
      (identifier) => identifier !== '' && !allowed.has(identifier),
    );
    if (remaining.length > 0) {
      throw gatewayError(
        'RUNTIME_UNLOAD_FAILED',
        `LM Studio still has ${remaining.length} unexpected model(s) resident after unloading strays`,
        { details: { runtime: runtime.id, adapter: id, served: remaining } },
      );
    }
  };

  /**
   * Bring the LM Studio server up from a probe, and report where it landed (§22).
   *
   * The only adapter that implements this, because `lms server start` is
   * daemon-style: it returns while the server keeps running. `mtplx serve` and
   * `omlx serve` are foreground processes, and `ProcessExecutor.spawn` is not
   * detached, so a server a probe spawned would die with the command.
   *
   * The port is read back rather than assumed: LM Studio may honour its own
   * configured port instead of the one asked for, and re-probing the wrong port
   * would report "not running" about a server that had just started.
   */
  const startServer = async (target: ProbeStartTarget): Promise<ProbeStartResult> => {
    const args = ['server', 'start'];
    // Omitted rather than guessed: with no port asked for, LM Studio's own
    // setting is the right answer, and the readback below reports it.
    if (target.port !== undefined) args.push('--port', String(target.port));
    await run(args);

    const status = await serverStatus();
    const port = status.port ?? target.port ?? DEFAULT_PORT;
    return { url: `http://${target.host}:${port}` };
  };

  const loadedIdentifiers = async (): Promise<string[]> => {
    return (await ps()).map((entry) => entry.identifier ?? entry.modelKey ?? '');
  };

  const ps = async (): Promise<PsEntry[]> => {
    const result = await run(['ps', '--json'], { allowFailure: true });
    if (result.code !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim() || '[]');
      return Array.isArray(parsed) ? (parsed as PsEntry[]) : [];
    } catch {
      return [];
    }
  };

  const serverStatus = async (): Promise<ServerStatus> => {
    const result = await run(['server', 'status', '--json'], { allowFailure: true });
    if (result.code !== 0) return { running: false, port: null };
    try {
      const parsed = JSON.parse(result.stdout.trim() || '{}') as Partial<ServerStatus>;
      return { running: parsed.running === true, port: parsed.port ?? null };
    } catch {
      return { running: false, port: null };
    }
  };

  const run = async (
    args: string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const result = await executor.run({
      command: binary,
      args: [...binaryArgs, ...args],
      timeoutMs: commandTimeoutMs,
    });
    if (result.code !== 0 && !options.allowFailure) {
      throw gatewayError(
        'RUNTIME_START_FAILED',
        `lms ${args.join(' ')} failed (exit ${result.code})`,
        {
          details: { adapter: id, detail: result.stderr.slice(0, 300) },
        },
      );
    }
    return result;
  };

  const port = (runtime: RuntimeInstance): number => {
    return runtime.port ?? DEFAULT_PORT;
  };

  const origin = (runtime: RuntimeInstance): string => {
    return `http://${runtime.host}:${port(runtime)}`;
  };

  const modelsUrl = (runtime: RuntimeInstance): string => {
    return joinUrl(origin(runtime), 'v1/models');
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
    declaredLimits,
    requiredExecutables,
    loadArgs,
  };
};
