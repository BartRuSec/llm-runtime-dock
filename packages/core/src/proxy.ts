import type { RuntimeAdapter } from './adapter.js';
import { gatewayError } from './errors.js';
import { joinUrl, resolveAuthValue } from './http/client.js';
import type { Logger } from './logging.js';
import type { Lease } from './scheduler.js';
import type { RuntimeInstance, Surface } from './types.js';

/**
 * Request proxying (spec §14).
 *
 * Both surfaces are proxied to runtimes that already serve them. The gateway
 * never rewrites Anthropic SSE into OpenAI chunks or the reverse, and never
 * invents a protocol bridge.
 */

export type UpstreamPath = 'chat/completions' | 'messages' | 'messages/count_tokens';

export const SURFACE_OF_PATH: Record<UpstreamPath, Surface> = {
  'chat/completions': 'openai',
  messages: 'anthropic',
  'messages/count_tokens': 'anthropic',
};

export interface ProxyRequest {
  readonly path: UpstreamPath;
  /** Raw request body exactly as the client sent it. */
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly requestId: string;
}

export interface ProxyResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly stream: ReadableStream<Uint8Array> | null;
  /** Present instead of `stream` when the upstream sent no body. */
  readonly text: string | null;
}

/** Headers that belong to this hop and must not be forwarded upstream. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'content-length',
]);

/**
 * Response headers the gateway must *not* re-emit. Everything else passes.
 *
 * A denylist rather than an allowlist, because a proxy that passes requests
 * through should pass answers through too. An allowlist silently dropped
 * `retry-after` — which agent clients back off on — along with
 * `www-authenticate` and every rate-limit header, and it would drop each new
 * upstream header the same way.
 *
 * `content-length` and `content-encoding` are the two that genuinely cannot
 * survive: `fetch` already decoded the upstream body, so re-emitting either
 * describes bytes that are no longer the ones being sent.
 */
const BLOCKED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'content-length', 'content-encoding']);

/**
 * An observer of what actually crossed the wire (§14).
 *
 * A tee, never a transform. Nothing it returns can change a byte the client or
 * the runtime sees, and every method must swallow its own failures: an
 * instrument that can break the thing it measures is worse than none.
 *
 * It exists because the gateway otherwise keeps no record of what it forwarded,
 * which makes "the gateway rewrote my request" unanswerable rather than false.
 *
 * Implementations receive credentials verbatim in `headers` and the full
 * conversation in `body`. Redacting the first and bounding the second is the
 * implementation's job, not the caller's.
 */
export interface RequestTap {
  /** What went upstream, after model resolution replaced the `model` field. */
  upstreamRequest(entry: TapUpstreamRequest): void;
  /** The upstream status and headers, both as sent and as the gateway will forward them. */
  upstreamResponse(entry: TapUpstreamResponse): void;
  /** One body chunk, tagged with the hop it was observed on. */
  body(entry: TapBody): void;
  end(entry: TapEnd): void;
}

export interface TapUpstreamRequest {
  readonly requestId: string;
  readonly path: UpstreamPath;
  readonly url: string;
  /** The logical entry that won the resident slot. */
  readonly runtime: string;
  readonly adapter: string;
  /** The id written into the body, which is what the runtime answers to (§13). */
  readonly servedModel: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface TapUpstreamResponse {
  readonly requestId: string;
  readonly status: number;
  /** Every header the upstream sent, before the gateway's response filter. */
  readonly headers: Readonly<Record<string, string>>;
  /** What survives the filter. The difference between the two is diagnostic. */
  readonly forwarded: Readonly<Record<string, string>>;
  readonly durationMs: number;
}

export interface TapBody {
  readonly requestId: string;
  /** `upstream` is what the runtime sent; `client` is what the gateway wrote out. */
  readonly hop: 'upstream' | 'client';
  readonly bytes: Uint8Array;
}

export interface TapEnd {
  readonly requestId: string;
  readonly reason: 'complete' | 'cancelled' | 'error';
  readonly durationMs: number;
  readonly detail?: string;
}

export interface ProxyDeps {
  readonly lease: Lease;
  readonly logger: Logger;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Called when the upstream connection fails, so the slot can be invalidated. */
  readonly onUpstreamFailure?: (reason: string) => void;
  /** Opt-in observer of the bytes this request exchanged. Off unless `--debug`. */
  readonly tap?: RequestTap;
}

export const proxyRequest = async (
  request: ProxyRequest,
  deps: ProxyDeps,
): Promise<ProxyResponse> => {
  const { lease, logger } = deps;
  const instance = lease.runtime;
  const adapter = lease.adapter;

  // Everything before the upstream call can throw: an unsupported surface, an
  // adapter that cannot state its endpoint, an unreadable credential. The lease
  // has to be handed back on every one of those paths. Otherwise the slot stays
  // occupied by a request that never ran, and the next switch — and every later
  // request, including one for the entry that is already resident — waits out
  // the whole drain timeout before failing (§8, §24).
  let prepared: PreparedRequest;
  try {
    prepared = await prepareUpstreamRequest(request, adapter, instance);
  } catch (error) {
    lease.release();
    throw error;
  }
  const { url, headers, body } = prepared;
  const tap = deps.tap;
  tap?.upstreamRequest({
    requestId: request.requestId,
    path: request.path,
    url,
    runtime: instance.id,
    adapter: adapter.id,
    servedModel: adapter.servedModelId(instance),
    headers,
    body,
  });

  const startedAt = Date.now();
  const doFetch = deps.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: request.signal,
      // Node's fetch buffers a duplex-less request; streaming is on the response.
    });
  } catch (error) {
    const failed = (error as Error).message;
    if (request.signal.aborted) {
      lease.release();
      tap?.end({
        requestId: request.requestId,
        reason: 'cancelled',
        durationMs: Date.now() - startedAt,
        detail: failed,
      });
      throw gatewayError('UPSTREAM_UNAVAILABLE', 'client cancelled the request', {
        details: { runtime: instance.id },
      });
    }
    lease.release();
    const message = (error as Error).message;
    deps.onUpstreamFailure?.(message);
    tap?.end({
      requestId: request.requestId,
      reason: 'error',
      durationMs: Date.now() - startedAt,
      detail: message,
    });
    throw gatewayError(
      'UPSTREAM_UNAVAILABLE',
      `cannot reach ${instance.adapterId} at ${url}: ${message}`,
      {
        details: { runtime: instance.id, adapter: instance.adapterId, url },
        cause: error,
      },
    );
  }

  logger.debug('upstream responded', {
    event: 'proxy.upstream',
    requestId: request.requestId,
    runtime: instance.id,
    adapter: adapter.id,
    status: upstream.status,
    durationMs: Date.now() - startedAt,
  });

  const responseHeaders: Record<string, string> = {};
  const upstreamHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    upstreamHeaders[name] = value;
    if (BLOCKED_RESPONSE_HEADERS.has(name)) return;
    // The gateway stamps its own request id on the way out, so the upstream's
    // is kept under a second name instead of being overwritten. Correlating a
    // gateway log line with a backend's own log needs both.
    responseHeaders[name === 'x-request-id' ? 'x-upstream-request-id' : key] = value;
  });
  tap?.upstreamResponse({
    requestId: request.requestId,
    status: upstream.status,
    headers: upstreamHeaders,
    forwarded: responseHeaders,
    durationMs: Date.now() - startedAt,
  });

  if (upstream.status === 401 || upstream.status === 403) {
    const detail = await upstream.text().catch(() => '');
    lease.release();
    // This is the one status whose body does not reach the client: it is
    // truncated into an error detail below. The tap gets the original, which is
    // exactly where an upstream's own explanation is most worth keeping.
    tap?.body({
      requestId: request.requestId,
      hop: 'upstream',
      bytes: new TextEncoder().encode(detail),
    });
    tap?.end({
      requestId: request.requestId,
      reason: 'error',
      durationMs: Date.now() - startedAt,
      detail: `upstream ${upstream.status}`,
    });
    throw gatewayError(
      'UPSTREAM_UNAUTHORIZED',
      `upstream rejected the request (${upstream.status})`,
      {
        details: {
          runtime: instance.id,
          url,
          status: upstream.status,
          detail: detail.slice(0, 200),
        },
        hint: "send an Authorization header, or configure the entry's auth block",
      },
    );
  }

  if (!upstream.body) {
    const text = await upstream.text();
    lease.release();
    tap?.body({
      requestId: request.requestId,
      hop: 'upstream',
      bytes: new TextEncoder().encode(text),
    });
    tap?.end({
      requestId: request.requestId,
      reason: 'complete',
      durationMs: Date.now() - startedAt,
    });
    return { status: upstream.status, headers: responseHeaders, stream: null, text };
  }

  // The lease is held until the stream closes, is cancelled, or fails: a
  // streaming request counts as active until then (§8).
  return {
    status: upstream.status,
    headers: responseHeaders,
    stream: releasingStream(upstream.body, {
      onChunk: (bytes) => tap?.body({ requestId: request.requestId, hop: 'upstream', bytes }),
      onDone: (reason, detail) => {
        lease.release();
        tap?.end({
          requestId: request.requestId,
          reason,
          durationMs: Date.now() - startedAt,
          ...(detail === undefined ? {} : { detail }),
        });
      },
    }),
    text: null,
  };
};

interface PreparedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Everything the upstream call needs, computed before the lease is at risk.
 *
 * Kept as one function so there is a single place that can throw between
 * acquiring the lease and handing it to `fetch`, and so its caller can release
 * the lease on every one of those paths.
 */
const prepareUpstreamRequest = async (
  request: ProxyRequest,
  adapter: RuntimeAdapter,
  instance: RuntimeInstance,
): Promise<PreparedRequest> => {
  await assertSurfaceSupported(adapter, instance, SURFACE_OF_PATH[request.path]);
  const endpoint = await adapter.endpoint(instance);
  return {
    url: joinUrl(endpoint.baseUrl, request.path),
    headers: buildUpstreamHeaders(request, instance, endpoint.authHeader),
    body: rewriteModelField(request.body, adapter.servedModelId(instance)),
  };
};

/**
 * Exported so the surface gap can be caught *before* the scheduler moves the
 * resident slot (§14). `proxyRequest` still checks, for callers that reach it
 * directly; on the gateway path the second check simply never fires.
 */
export const assertSurfaceSupported = async (
  adapter: RuntimeAdapter,
  instance: RuntimeInstance,
  surface: Surface,
): Promise<void> => {
  const capabilities = await adapter.capabilities(instance);
  if (capabilities.surfaces.includes(surface)) return;
  throw gatewayError(
    'UPSTREAM_SURFACE_UNSUPPORTED',
    `entry "${instance.id}" (${adapter.id}) does not serve the ${surface} surface`,
    {
      details: {
        runtime: instance.id,
        adapter: adapter.id,
        surface,
        serves: [...capabilities.surfaces],
      },
      hint: `this runtime serves: ${capabilities.surfaces.join(', ')}`,
    },
  );
};

const buildUpstreamHeaders = (
  request: ProxyRequest,
  instance: RuntimeInstance,
  authHeader: { name: string; value: string } | undefined,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers['content-type'] = 'application/json';

  // §12: the client's Authorization header is forwarded verbatim. A configured
  // credential is used only when the client sent none.
  const clientAuthorized = Object.keys(request.headers).some(
    (name) => name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key',
  );
  if (!clientAuthorized) {
    if (authHeader) {
      headers[authHeader.name] = authHeader.value;
    } else {
      const value = resolveAuthValue(instance.auth);
      if (value) headers.authorization = `Bearer ${value}`;
    }
  }
  return headers;
};

/**
 * Replace exactly the `model` field with the id the upstream answers to (§13).
 *
 * This is the one field the gateway touches. It is model resolution, not request
 * rewriting: the client names a logical entry, and the backend model name must
 * not need to be exposed to it (§12 forbids injecting *inference* defaults, and
 * none are added here).
 */
export const rewriteModelField = (body: string, servedModelId: string): string => {
  if (body.trim() === '') return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: pass it through untouched and let the upstream reject it.
    // Unreachable from HTTP — `readModelField` in the service already threw
    // MODEL_NOT_FOUND on an unparseable body — so this guards direct callers of
    // core, and its tests.
    return body;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const record = parsed as Record<string, unknown>;
  if (!('model' in record)) return body;
  record.model = servedModelId;
  return JSON.stringify(record);
};

interface StreamHooks {
  /** Observes each chunk on its way through. Must not alter it. */
  readonly onChunk: (bytes: Uint8Array) => void;
  /** Invoked exactly once, whatever ends the stream. */
  readonly onDone: (reason: TapEnd['reason'], detail?: string) => void;
}

/** Pipe a stream through, invoking `onDone` exactly once when it finishes. */
const releasingStream = (
  source: ReadableStream<Uint8Array>,
  hooks: StreamHooks,
): ReadableStream<Uint8Array> => {
  let finished = false;
  const finish = (reason: TapEnd['reason'], detail?: string): void => {
    if (finished) return;
    finished = true;
    hooks.onDone(reason, detail);
  };
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish('complete');
          return;
        }
        hooks.onChunk(value);
        controller.enqueue(value);
      } catch (error) {
        finish('error', (error as Error).message);
        controller.error(error);
      }
    },
    cancel: async (reason) => {
      finish('cancelled', reason === undefined ? undefined : String(reason));
      await reader.cancel(reason).catch(() => {});
    },
  });
};
