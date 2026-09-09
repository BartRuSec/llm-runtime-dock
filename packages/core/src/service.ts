import type { DockConfig } from './config/load.js';
import { gatewayError } from './errors.js';
import type { Logger } from './logging.js';
import { nullLogger } from './logging.js';
import type { ProxyRequest, ProxyResponse, RequestTap, UpstreamPath } from './proxy.js';
import { assertSurfaceSupported, proxyRequest, SURFACE_OF_PATH } from './proxy.js';
import type { AdapterRegistry } from './registry.js';
import { listLogicalModels, resolveModel, servedModelIds } from './resolution.js';
import type { Scheduler, SchedulerStatus } from './scheduler.js';
import { createScheduler } from './scheduler.js';
import type { RuntimeInstance } from './types.js';

/**
 * Application layer shared by the gateway and the CLI (spec §27).
 *
 * Route handlers call this; no orchestration logic lives in HTTP handlers, and
 * the CLI is a client rather than a second implementation.
 */

export interface DockServiceOptions {
  readonly config: DockConfig;
  readonly registry: AdapterRegistry;
  readonly logger?: Logger;
  readonly readyTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Opt-in observer of proxied bytes. Off unless `lrd serve --debug` (§14). */
  readonly tap?: RequestTap;
}

export interface GatewayStatus extends SchedulerStatus {
  readonly configPath: string;
  readonly server: { host: string; port: number };
  readonly models: string[];
}

export interface DockService {
  readonly config: DockConfig;
  readonly registry: AdapterRegistry;
  readonly scheduler: Scheduler;
  listModels(): ReturnType<typeof listLogicalModels>;
  resolve(clientModelId: unknown): RuntimeInstance;
  status(): GatewayStatus;
  /**
   * Resolve, make resident, and proxy. The lease is held for the whole request,
   * including its stream, so a switch cannot cut it off (§8).
   */
  proxy(input: {
    path: UpstreamPath;
    body: string;
    headers: Readonly<Record<string, string | undefined>>;
    signal: AbortSignal;
    requestId: string;
  }): Promise<ProxyResponse>;
  /** `POST /switch`: through the scheduler, exactly like a request (§14). */
  switchTo(clientModelId: unknown, requestId?: string): Promise<GatewayStatus>;
  shutdown(): Promise<void>;
}

export const createDockService = (options: DockServiceOptions): DockService => {
  const config = options.config;
  const registry = options.registry;
  const logger = options.logger ?? nullLogger;
  const fetchImpl = options.fetchImpl;
  const scheduler = createScheduler({
    registry,
    logger,
    readyTimeoutMs: options.readyTimeoutMs,
    drainTimeoutMs: options.drainTimeoutMs,
  });

  const resolve = (clientModelId: unknown): RuntimeInstance => resolveModel(config, clientModelId);

  const status = (): GatewayStatus => ({
    ...scheduler.status(),
    configPath: config.location.path,
    server: { host: config.server.host, port: config.server.port },
    // What this gateway serves, which is not every configured entry: a
    // disabled one is recorded and unroutable (§12).
    models: servedModelIds(config),
  });

  const proxy = async (input: {
    path: UpstreamPath;
    body: string;
    headers: Readonly<Record<string, string | undefined>>;
    signal: AbortSignal;
    requestId: string;
  }): Promise<ProxyResponse> => {
    const instance = resolve(readModelField(input.body));
    const log = logger.child({
      requestId: input.requestId,
      runtime: instance.id,
      adapter: instance.adapterId,
      model: instance.backendModel,
    });
    log.info('routing request', { event: 'request.routed', path: input.path });

    // Before the slot moves. A runtime that does not serve this surface can
    // never answer, so switching to it would load a model — and, for a rotating
    // target, release the current occupant — for a request that is already
    // doomed. A `keep_resident` target evicts nothing, so only the wasted load
    // applies there, but the check is free either way. Every adapter states its
    // surfaces from configuration alone — no process, no network — so this is
    // safe to ask before anything is resident (§14, §23).
    await assertSurfaceSupported(
      registry.get(instance.adapterId),
      instance,
      SURFACE_OF_PATH[input.path],
    );

    const lease = await scheduler.acquire(instance, {
      signal: input.signal,
      requestId: input.requestId,
    });

    const request: ProxyRequest = {
      path: input.path,
      body: input.body,
      headers: input.headers,
      signal: input.signal,
      requestId: input.requestId,
    };
    return await proxyRequest(request, {
      lease,
      logger: log,
      fetchImpl,
      onUpstreamFailure: (reason) => scheduler.reportUpstreamFailure(instance.id, reason),
      ...(options.tap ? { tap: options.tap } : {}),
    });
  };

  const switchTo = async (clientModelId: unknown, requestId?: string): Promise<GatewayStatus> => {
    const instance = resolve(clientModelId);
    logger.info('explicit switch requested', {
      event: 'switch.requested',
      runtime: instance.id,
      requestId,
    });
    await scheduler.switchTo(instance, { requestId });
    return status();
  };

  return {
    config,
    registry,
    scheduler,
    listModels: () => listLogicalModels(config),
    resolve,
    status,
    proxy,
    switchTo,
    shutdown: () => scheduler.shutdown(),
  };
};

const readModelField = (body: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>).model;
    }
  } catch {
    throw gatewayError('MODEL_NOT_FOUND', 'request body is not valid JSON');
  }
  return undefined;
};
