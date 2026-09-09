import type {
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
  ProbeTarget,
  ProcessExecutor,
  ReservedArg,
  RuntimeAdapter,
  RuntimeInstance,
  Surface,
  WaitOptions,
} from '@llm-runtime-dock/core';
import {
  createProcessExecutor,
  gatewayError,
  httpJson,
  nullLogger,
  probeHealth,
  resolveAuthValue,
  suggestKeyForServedId,
  waitUntilHealthy,
  waitUntilUnreachable,
} from '@llm-runtime-dock/core';
import type { CustomEntry } from './config.js';
import { validateCustomOptions } from './config.js';

/**
 * Custom YAML adapter (spec §11).
 *
 * SECURITY: lifecycle commands come from configuration and nothing else. The
 * argv array is used verbatim — no string interpolation, no template, and no
 * value originating from an HTTP request ever reaches it. Shell execution
 * requires an explicit `shell: true` in the configuration.
 */

export interface CustomAdapterOptions {
  readonly executor?: ProcessExecutor;
  readonly logger?: Logger;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export const createCustomAdapter = (options: CustomAdapterOptions = {}): RuntimeAdapter => {
  const id = 'custom';
  /** No lever other than the configured stop command (§8). */
  const modelRelease = 'stop_server' as const;
  /** A user-defined runtime has no conventional port, so discovery needs --url. */
  const defaultProbeTarget = null;
  /** Everything runtime-specific lives in the entry's own blocks, not in `options`. */
  const optionSpecs = {};
  /** The user owns the whole argv here, so §12's reserved list does not apply. */
  const reservedArgs: readonly ReservedArg[] = [];
  const serverScopedOptionKeys: readonly string[] = [];
  const spawned = new Map<string, ManagedProcess>();
  const logger = options.logger ?? nullLogger;
  const executor = options.executor ?? createProcessExecutor(logger);
  const defaultStartupTimeoutMs = options.startupTimeoutMs ?? 120_000;
  const defaultShutdownTimeoutMs = options.shutdownTimeoutMs ?? 15_000;

  // A user-defined runtime has no conventional endpoint, so the address is the
  // whole question rather than a default to confirm.
  const probeQuestions: readonly ProbeQuestion[] = [
    { key: 'host', label: 'host', type: 'string', default: '127.0.0.1' },
    { key: 'port', label: 'port', type: 'number' },
    {
      key: 'api_key_env',
      label: 'environment variable holding the API key (blank for none)',
      type: 'string',
    },
  ];

  const validateOptions = (raw: unknown, context: OptionValidationContext): CustomEntry => {
    return validateCustomOptions(raw, context);
  };

  const probe = async (target: ProbeTarget): Promise<ProbeResult> => {
    const headers: Record<string, string> = {};
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    const url = target.url.endsWith('/models')
      ? target.url
      : `${target.url.replace(/\/+$/, '')}/v1/models`;
    let response: Awaited<ReturnType<typeof httpJson<{ data?: Array<{ id?: string }> }>>>;
    try {
      response = await httpJson<{ data?: Array<{ id?: string }> }>(url, {
        headers,
        timeoutMs: target.timeoutMs ?? 3_000,
      });
    } catch (error) {
      return { status: 'not_running', url: target.url, detail: (error as Error).message };
    }
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
   * The custom adapter probes `endpoint.url` to decide between attaching and
   * spawning (§11), since it has no `port` field of its own.
   */
  const acquire = async (
    runtime: RuntimeInstance,
    options: WaitOptions = {},
  ): Promise<AcquireResult> => {
    const entry = entryOf(runtime);
    // An explicit startup_timeout_ms in the entry wins: it is the user stating
    // how slow this particular runtime is, which the caller cannot know.
    const timeoutMs =
      entry.process.startup_timeout_ms ?? options.timeoutMs ?? defaultStartupTimeoutMs;
    const health = await probeHealth(entry.health.url, {
      timeoutMs: entry.health.timeout_ms ?? 3_000,
    });

    if (health.state !== 'unreachable') {
      await waitUntilHealthy(entry.health.url, { timeoutMs, signal: options.signal });
      const identity = await verifyIdentity(runtime);
      if (identity.ok) return { ownership: 'attached' };
      logger.warn(
        `releasing foreign custom server at ${entry.endpoint.url} to free the resident slot`,
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

  const release = async (runtime: RuntimeInstance, options: WaitOptions = {}): Promise<void> => {
    await stop(runtime, options);
  };

  const start = async (runtime: RuntimeInstance, options: WaitOptions = {}): Promise<void> => {
    const entry = entryOf(runtime);
    const start = entry.process.start;
    // The argv array is passed straight through. See the security note above.
    const managed = executor.spawn({
      command: start.command[0] as string,
      args: start.command.slice(1),
      cwd: entry.process.cwd,
      env: entry.process.env,
      shell: start.shell === true,
    });
    spawned.set(runtime.id, managed);

    const timeoutMs =
      entry.process.startup_timeout_ms ?? options.timeoutMs ?? defaultStartupTimeoutMs;
    const ready = waitUntilHealthy(entry.health.url, { timeoutMs, signal: options.signal }).then(
      () => 'ready' as const,
    );
    const outcome = await Promise.race([ready, managed.exited]);
    if (outcome !== 'ready') {
      const spawnError = managed.error();
      throw gatewayError(
        'RUNTIME_START_FAILED',
        spawnError
          ? `could not run ${start.command[0]}: ${spawnError.message}`
          : `${start.command[0]} exited during startup (code ${outcome.code ?? 'null'})`,
        {
          details: {
            runtime: runtime.id,
            adapter: id,
            detail: managed.logs().slice(-20).join('\n').slice(0, 500),
          },
          hint: spawnError
            ? 'check process.start.command and that the executable is on PATH'
            : undefined,
        },
      );
    }
  };

  const stop = async (runtime: RuntimeInstance, options: WaitOptions = {}): Promise<void> => {
    const entry = entryOf(runtime);
    const timeoutMs =
      entry.process.shutdown_timeout_ms ?? options.timeoutMs ?? defaultShutdownTimeoutMs;

    if (entry.process.stop) {
      const stop = entry.process.stop;
      try {
        await executor.run({
          command: stop.command[0] as string,
          args: stop.command.slice(1),
          cwd: entry.process.cwd,
          env: entry.process.env,
          shell: stop.shell === true,
          timeoutMs,
        });
      } catch (error) {
        logger.warn('configured stop command reported an error', {
          event: 'runtime.stop_error',
          runtime: runtime.id,
          adapter: id,
          error: (error as Error).message,
        });
      }
    }

    const managed = spawned.get(runtime.id);
    if (managed && !managed.hasExited()) {
      await managed.stop({ timeoutMs });
    }
    spawned.delete(runtime.id);

    const gone = await waitUntilUnreachable(entry.health.url, { timeoutMs });
    if (!gone) {
      throw gatewayError(
        'RUNTIME_STOP_FAILED',
        `${entry.health.url} is still answering after the stop command; the resident slot cannot be freed`,
        { details: { runtime: runtime.id, adapter: id } },
      );
    }
  };

  const health = async (runtime: RuntimeInstance): Promise<HealthStatus> => {
    const entry = entryOf(runtime);
    return await probeHealth(entry.health.url, { timeoutMs: entry.health.timeout_ms ?? 5_000 });
  };

  const waitUntilReady = async (
    runtime: RuntimeInstance,
    options: WaitOptions = {},
  ): Promise<void> => {
    const entry = entryOf(runtime);
    await waitUntilHealthy(entry.health.url, {
      timeoutMs: entry.process.startup_timeout_ms ?? options.timeoutMs ?? defaultStartupTimeoutMs,
      intervalMs: options.intervalMs,
      signal: options.signal,
    });
  };

  const listModels = async (runtime: RuntimeInstance): Promise<ModelInfo[]> => {
    const entry = entryOf(runtime);
    const response = await httpJson<{ data?: Array<{ id?: string }> }>(entry.model_discovery.url, {
      headers: authHeaders(runtime),
      timeoutMs: entry.model_discovery.timeout_ms ?? 10_000,
    });
    if (response.status === 401 || response.status === 403) {
      throw gatewayError('UPSTREAM_UNAUTHORIZED', `model discovery rejected (${response.status})`, {
        details: { runtime: runtime.id, adapter: id },
      });
    }
    if (!response.ok || !response.body?.data) return [];
    return response.body.data
      .filter((item): item is { id: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, loaded: true }));
  };

  /** Source of truth is the configured `model_discovery.url` (§17). */
  const verifyIdentity = async (runtime: RuntimeInstance): Promise<IdentityCheck> => {
    try {
      const served = (await listModels(runtime)).map((model) => model.id);
      return { ok: served.includes(runtime.backendModel), served };
    } catch (error) {
      return { ok: false, served: [], detail: (error as Error).message };
    }
  };

  const servedModelId = (runtime: RuntimeInstance): string => {
    return runtime.backendModel;
  };

  /** OpenAI only unless the entry explicitly opts in to more (§11). */
  const capabilities = async (runtime: RuntimeInstance): Promise<Capabilities> => {
    const entry = entryOf(runtime);
    const surfaces: readonly Surface[] = entry.surfaces ?? ['openai'];
    return { surfaces, streaming: true };
  };

  const endpoint = async (runtime: RuntimeInstance): Promise<Endpoint> => {
    const entry = entryOf(runtime);
    const value = resolveAuthValue(runtime.auth);
    return {
      baseUrl: entry.endpoint.url,
      ...(value ? { authHeader: { name: 'authorization', value: `Bearer ${value}` } } : {}),
    };
  };

  const requiredExecutables = (runtime: RuntimeInstance): string[] => {
    const entry = entryOf(runtime);
    const commands = [entry.process.start.command[0] as string];
    if (entry.process.stop) commands.push(entry.process.stop.command[0] as string);
    return commands;
  };

  const logs = (runtime: RuntimeInstance): string[] => {
    return spawned.get(runtime.id)?.logs() ?? [];
  };

  const entryOf = (runtime: RuntimeInstance): CustomEntry => {
    return runtime.options as CustomEntry;
  };

  const authHeaders = (runtime: RuntimeInstance): Record<string, string> => {
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
    requiredExecutables,
    logs,
  };
};
