import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DockService, Logger, RequestTap, UpstreamPath } from '@llm-runtime-dock/core';
import { gatewayError, nullLogger } from '@llm-runtime-dock/core';
import { toErrorResponse } from './errors.js';

/**
 * The HTTP surface (spec §14).
 *
 * Route handlers do no orchestration: they parse, delegate to `DockService` and
 * write the answer back. Everything about the resident slot, switching and
 * draining lives in core.
 */

export interface GatewayOptions {
  readonly service: DockService;
  readonly logger?: Logger;
  readonly host?: string;
  readonly port?: number;
  /**
   * Opt-in observer of proxied bytes (§14). The same tap the service holds: it
   * sees the upstream hop, this sees what the pump actually wrote to the
   * client. Capturing only one hop would assume the relay is byte-for-byte,
   * which is the very thing the capture exists to check.
   */
  readonly tap?: RequestTap;
}

export interface RunningGateway {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /**
   * Stop serving and free every loaded model.
   *
   * `graceMs` is the *most* an in-flight request may keep the process alive
   * before its socket is destroyed, not a wait that is always paid: closing
   * finishes as soon as the last request does. See `close`.
   */
  close(options?: { graceMs?: number }): Promise<void>;
}

/**
 * How long a shutdown waits for active requests before destroying their
 * sockets.
 *
 * Long enough for a normal response to land, short enough that a held stream
 * cannot keep a model in memory indefinitely. This is not the scheduler's drain
 * timeout (§24): draining exists so a *switch* never cuts off a client, and the
 * client survives it. Here the process is going away regardless, so waiting
 * longer only delays freeing the GPU.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (!address) return false;
  return LOOPBACK_HOSTS.has(address) || address.startsWith('127.');
};

export const createGateway = (options: GatewayOptions): Server => {
  const { service } = options;
  const logger = options.logger ?? nullLogger;
  const bindHost = options.host ?? service.config.server.host;
  const tap = options.tap;

  return createServer((req, res) => {
    void handle(req, res, service, logger, bindHost, tap).catch((error: unknown) => {
      const { status, body } = toErrorResponse(error);
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify(body));
    });
  });
};

const handle = async (
  req: IncomingMessage,
  res: ServerResponse,
  service: DockService,
  logger: Logger,
  bindHost: string,
  tap: RequestTap | undefined,
): Promise<void> => {
  const requestId = headerValue(req, 'x-request-id') ?? randomUUID();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  res.setHeader('x-request-id', requestId);

  if (method === 'GET' && (path === '/health' || path === '/healthz')) {
    sendJson(res, 200, { status: 'ok', service: 'llm-runtime-dock' });
    return;
  }

  if (method === 'GET' && path === '/v1/models') {
    sendJson(res, 200, service.listModels());
    return;
  }

  if (path === '/status' || path === '/switch') {
    // Lifecycle controls bind to loopback only (§28). Two checks: the gateway
    // must itself be bound to a loopback address, and the peer must be local.
    // A refusal is answered directly rather than through the gateway error
    // namespace: none of those codes means "forbidden", and reusing one would
    // read as a transient condition to a client that should simply stop asking.
    const refusal = loopbackRefusal(req, bindHost, path);
    if (refusal) {
      sendJson(res, 403, refusal);
      return;
    }
    if (method === 'GET' && path === '/status') {
      sendJson(res, 200, service.status());
      return;
    }
    if (method === 'POST' && path === '/switch') {
      const body = await readBody(req);
      const model = parseSwitchBody(body);
      const status = await service.switchTo(model, requestId);
      sendJson(res, 200, status);
      return;
    }
    sendJson(res, 405, {
      error: { message: `method ${method} not allowed on ${path}`, type: 'invalid_request_error' },
    });
    return;
  }

  const upstreamPath = UPSTREAM_ROUTES[path];
  if (upstreamPath) {
    if (method !== 'POST') {
      sendJson(res, 405, {
        error: {
          message: `method ${method} not allowed on ${path}`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
    await proxy(req, res, service, logger, upstreamPath, requestId, tap);
    return;
  }

  sendJson(res, 404, {
    error: { message: `no route for ${method} ${path}`, type: 'invalid_request_error' },
  });
};

const UPSTREAM_ROUTES: Record<string, UpstreamPath | undefined> = {
  '/v1/chat/completions': 'chat/completions',
  '/v1/messages': 'messages',
  '/v1/messages/count_tokens': 'messages/count_tokens',
};

const proxy = async (
  req: IncomingMessage,
  res: ServerResponse,
  service: DockService,
  logger: Logger,
  path: UpstreamPath,
  requestId: string,
  tap: RequestTap | undefined,
): Promise<void> => {
  const body = await readBody(req);
  const controller = new AbortController();
  // A client that disconnects mid-stream cancels the upstream request and, with
  // it, the lease that keeps the runtime from switching (§14).
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  };
  req.once('aborted', onClose);
  res.once('close', onClose);

  const response = await service.proxy({
    path,
    body,
    headers: forwardableHeaders(req),
    signal: controller.signal,
    requestId,
  });

  res.writeHead(response.status, { ...response.headers, 'x-request-id': requestId });

  if (response.stream === null) {
    const text = response.text ?? '';
    res.end(text);
    tap?.body({ requestId, hop: 'client', bytes: new TextEncoder().encode(text) });
    return;
  }

  // Stream through unaltered: no rewriting of SSE events in either direction.
  const reader = response.stream.getReader();
  let upstreamClosed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        upstreamClosed = true;
        break;
      }
      if (res.destroyed || res.writableEnded) break;
      const written = res.write(Buffer.from(value));
      tap?.body({ requestId, hop: 'client', bytes: value });
      if (!written) {
        if (!(await waitForClientDrain(res))) break;
      }
    }
  } catch (error) {
    logger.warn('stream ended abnormally', {
      event: 'proxy.stream_error',
      requestId,
      error: (error as Error).message,
    });
  } finally {
    // Whatever ended the loop, the upstream stream has to be closed out here.
    // Cancelling it is what runs the release path that hands back the lease on
    // the resident slot; leaving it open holds the slot until the scheduler's
    // drain timeout fires (§8, §24).
    if (!upstreamClosed) await reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
};

/**
 * Wait until the client socket can take more bytes, or until it goes away.
 *
 * A client that disconnects mid-stream destroys its socket, and a destroyed
 * socket never emits `drain`. Waiting on `drain` alone parks the pump forever:
 * `reader.read()` is never called again, so the stream never finishes, the
 * lease is never released, and the next switch waits out the whole drain
 * timeout before failing. Returns false when there is no longer anyone to
 * write to.
 */
const waitForClientDrain = async (res: ServerResponse): Promise<boolean> => {
  if (res.destroyed || res.writableEnded) return false;
  return await new Promise<boolean>((resolve) => {
    const settle = (drained: boolean): void => {
      res.off('drain', onDrain);
      res.off('close', onGone);
      res.off('error', onGone);
      resolve(drained);
    };
    const onDrain = (): void => settle(true);
    const onGone = (): void => settle(false);
    res.once('drain', onDrain);
    res.once('close', onGone);
    res.once('error', onGone);
  });
};

interface RefusalBody {
  error: { message: string; type: 'invalid_request_error'; code: 'loopback_only'; param: null };
}

const loopbackRefusal = (
  req: IncomingMessage,
  bindHost: string,
  path: string,
): RefusalBody | null => {
  const refuse = (message: string): RefusalBody => ({
    error: { message, type: 'invalid_request_error', code: 'loopback_only', param: null },
  });
  if (!isLoopbackAddress(bindHost)) {
    return refuse(
      `${path} is a lifecycle control and is refused while the gateway is bound to ${bindHost}. ` +
        'Bind to 127.0.0.1: the MVP has no authentication for remote lifecycle control.',
    );
  }
  if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
    return refuse(`${path} is available on loopback only`);
  }
  return null;
};

const parseSwitchBody = (body: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    throw gatewayError('MODEL_NOT_FOUND', '/switch expects a JSON body with a "model" field');
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const model = (parsed as Record<string, unknown>).model;
    if (typeof model === 'string' && model.trim() !== '') return model;
  }
  throw gatewayError('MODEL_NOT_FOUND', '/switch expects a JSON body with a "model" field');
};

const forwardableHeaders = (req: IncomingMessage): Record<string, string | undefined> => {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
};

const headerValue = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Start the gateway and resolve once it is listening. */
export const startGateway = async (options: GatewayOptions): Promise<RunningGateway> => {
  const service = options.service;
  const host = options.host ?? service.config.server.host;
  const port = options.port ?? service.config.server.port;
  const server = createGateway({ ...options, host, port });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    /**
     * `server.close()` resolves only once every connection has ended, and an
     * open SSE stream never ends on its own. Left at that, a shutdown during a
     * streaming response hangs forever and `service.shutdown()` is never
     * reached — which orphans every loaded model, including the ones
     * `keep_resident` is holding (§8). The models outliving the process that
     * loaded them is the exact leak this gateway exists to prevent, so the wait
     * is bounded and then forced.
     */
    close: async (closeOptions = {}) => {
      const graceMs = closeOptions.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Sockets merely parked on keep-alive are holding nothing; drop them now
      // rather than spending the grace period on them.
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        options.logger?.warn('destroying active connections to finish shutting down', {
          event: 'gateway.force_close',
          graceMs,
        });
        server.closeAllConnections();
      }, graceMs);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
        // Always, even if closing the listener misbehaved: releasing the models
        // is the part that must not be skipped.
        await service.shutdown();
      }
    },
  };
};
