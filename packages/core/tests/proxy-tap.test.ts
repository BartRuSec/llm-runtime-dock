import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAdapterRegistry,
  createDebugTap,
  parseConfig,
  proxyRequest,
  type Lease,
  type ProxyResponse,
  type RequestTap,
  type TapBody,
  type TapEnd,
  type TapUpstreamRequest,
  type TapUpstreamResponse,
} from '../src/index.js';
import { createStubAdapter, tempDir, testLocation } from './helpers/stubs.js';

/**
 * What the gateway forwards and what it hands back (§14): the response-header
 * contract, and the `--debug` capture that makes both inspectable.
 */

const adapter = createStubAdapter();
const config = parseConfig(
  createAdapterRegistry([adapter]),
  'runtimes:\n  stub: { adapter: stub, port: 8000 }\nmodels:\n  quality: { runtime: stub, backend_model: Some-Model-27B }\n',
  testLocation(),
);
const instance = config.models.get('quality')!;

const leaseFor = (): Lease & { released: number } => {
  const lease = {
    runtime: instance,
    adapter,
    released: 0,
    release: (): void => {
      lease.released += 1;
    },
  };
  return lease;
};

const request = (body = JSON.stringify({ model: 'quality', messages: [] })) => ({
  path: 'chat/completions' as const,
  body,
  headers: { authorization: 'Bearer super-secret', 'user-agent': 'opencode/1.0' },
  signal: new AbortController().signal,
  requestId: 'req-1',
});

const send = async (
  upstream: Response,
  tap?: RequestTap,
): Promise<{ response: ProxyResponse; lease: Lease & { released: number }; sent: Request[] }> => {
  const lease = leaseFor();
  const sent: Request[] = [];
  const response = await proxyRequest(request(), {
    lease,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => nullLog,
    },
    fetchImpl: async (url, init) => {
      sent.push(new Request(String(url), init as RequestInit));
      return upstream;
    },
    ...(tap ? { tap } : {}),
  });
  return { response, lease, sent };
};

const nullLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLog,
};

/**
 * Read a proxied response to completion.
 *
 * A `ReadableStream` pulls one chunk eagerly to fill its queue, so a test that
 * never reads still sees a first `body` event but no `end` — the stream has to
 * be consumed for the release path to run.
 */
const drain = async (response: ProxyResponse): Promise<string> => {
  if (!response.stream) return response.text ?? '';
  const reader = response.stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return out;
};

describe('response headers', () => {
  it('passes an upstream header through instead of dropping what it did not name', async () => {
    // The allowlist this replaced silently swallowed `retry-after`, which agent
    // clients back off on, and would have swallowed every future header too.
    const upstream = new Response('{}', {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '30',
        'x-ratelimit-remaining': '0',
        'anthropic-ratelimit-requests-limit': '100',
      },
    });
    const { response } = await send(upstream);
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.headers['x-ratelimit-remaining']).toBe('0');
    expect(response.headers['anthropic-ratelimit-requests-limit']).toBe('100');
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('drops the two headers that cannot survive the hop', async () => {
    // `fetch` already decoded the body, so both would describe bytes that are
    // no longer the ones being sent.
    const upstream = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '999' },
    });
    const { response } = await send(upstream);
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it("keeps the upstream's request id under a second name rather than losing it", async () => {
    const upstream = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'mtplx-42' },
    });
    const { response } = await send(upstream);
    // The gateway stamps its own id on the way out; correlating its log with
    // the backend's needs the backend's too.
    expect(response.headers['x-upstream-request-id']).toBe('mtplx-42');
    expect(response.headers['x-request-id']).toBeUndefined();
  });
});

describe('request tap', () => {
  it('reports the body as sent upstream, not as the client wrote it', async () => {
    const seen: TapUpstreamRequest[] = [];
    const tap: RequestTap = {
      upstreamRequest: (entry) => seen.push(entry),
      upstreamResponse: () => {},
      body: () => {},
      end: () => {},
    };
    await send(new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }), tap);

    expect(seen).toHaveLength(1);
    const entry = seen[0]!;
    // Model resolution has already happened: this is the id the runtime answers
    // to, which is the whole point of capturing here rather than at the socket.
    expect(entry.servedModel).toBe('Some-Model-27B');
    expect(JSON.parse(entry.body)).toMatchObject({ model: 'Some-Model-27B' });
    expect(entry.runtime).toBe('quality');
    expect(entry.headers['user-agent']).toBe('opencode/1.0');
  });

  it('records the upstream headers alongside the ones that survive the filter', async () => {
    const seen: TapUpstreamResponse[] = [];
    const tap: RequestTap = {
      upstreamRequest: () => {},
      upstreamResponse: (entry) => seen.push(entry),
      body: () => {},
      end: () => {},
    };
    await send(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      }),
      tap,
    );
    const entry = seen[0]!;
    // The difference between the two is the diagnostic: it shows what the
    // gateway itself removed.
    expect(entry.headers['content-length']).toBe('2');
    expect(entry.forwarded['content-length']).toBeUndefined();
  });

  it('captures a streamed body chunk by chunk and ends once the stream closes', async () => {
    const bodies: TapBody[] = [];
    const ends: TapEnd[] = [];
    const tap: RequestTap = {
      upstreamRequest: () => {},
      upstreamResponse: () => {},
      body: (entry) => bodies.push(entry),
      end: (entry) => ends.push(entry),
    };
    const sse = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const { response, lease } = await send(
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      tap,
    );

    const reader = response.stream!.getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    // The stream the client got is untouched, and the tap saw the same bytes.
    expect(out).toContain('data: [DONE]');
    expect(bodies.map((b) => new TextDecoder().decode(b.bytes)).join('')).toBe(out);
    expect(bodies.every((b) => b.hop === 'upstream')).toBe(true);
    expect(ends).toEqual([
      { requestId: 'req-1', reason: 'complete', durationMs: expect.any(Number) },
    ]);
    expect(lease.released).toBe(1);
  });

  it('captures the 401 body the client never sees', async () => {
    const bodies: TapBody[] = [];
    const tap: RequestTap = {
      upstreamRequest: () => {},
      upstreamResponse: () => {},
      body: (entry) => bodies.push(entry),
      end: () => {},
    };
    // This body is truncated into an error detail, so the capture is the only
    // place the upstream's own explanation survives in full.
    const detail = `{"error":"${'x'.repeat(400)}"}`;
    await expect(send(new Response(detail, { status: 401 }), tap)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAUTHORIZED',
    });
    expect(new TextDecoder().decode(bodies[0]!.bytes)).toBe(detail);
  });
});

describe('debug capture file', () => {
  const dirs: Array<{ cleanup: () => void }> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) dir.cleanup();
  });

  const tapInTempDir = (maxBodyBytes?: number) => {
    const dir = tempDir();
    dirs.push(dir);
    return createDebugTap({ dir: dir.path, ...(maxBodyBytes ? { maxBodyBytes } : {}) });
  };

  const linesOf = (path: string): Array<Record<string, unknown>> =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('writes NDJSON with the credential redacted and the body intact', async () => {
    const tap = tapInTempDir();
    const { response } = await send(new Response('{"ok":true}', { status: 200 }), tap);
    await drain(response);
    await tap.close();

    const lines = linesOf(tap.path);
    const requestLine = lines.find((l) => l.event === 'request')!;
    const headers = requestLine.headers as Record<string, string>;
    expect(headers.authorization).toBe('[redacted]');
    expect(readFileSync(tap.path, 'utf8')).not.toContain('super-secret');
    // The transcript itself is not redacted: it is the thing being inspected.
    expect(requestLine.body).toContain('Some-Model-27B');
    expect(lines.map((l) => l.event)).toEqual(['request', 'response', 'body', 'end']);
  });

  it('bounds a body and says so, rather than truncating silently', async () => {
    const tap = tapInTempDir(8);
    tap.body({ requestId: 'r', hop: 'upstream', bytes: new TextEncoder().encode('12345678') });
    tap.body({ requestId: 'r', hop: 'upstream', bytes: new TextEncoder().encode('9') });
    tap.body({ requestId: 'r', hop: 'upstream', bytes: new TextEncoder().encode('10') });
    await tap.close();

    const bodies = linesOf(tap.path).filter((l) => l.event === 'body');
    expect(bodies[0]).toMatchObject({ seq: 0, text: '12345678' });
    // One marker, then silence for that hop — not a marker per later chunk.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ truncated: true, limitBytes: 8 });
  });

  it('decodes a character split across two chunks', async () => {
    const tap = tapInTempDir();
    const bytes = new TextEncoder().encode('zażółć');
    tap.body({ requestId: 'r', hop: 'upstream', bytes: bytes.slice(0, 3) });
    tap.body({ requestId: 'r', hop: 'upstream', bytes: bytes.slice(3) });
    await tap.close();

    const text = linesOf(tap.path)
      .filter((l) => l.event === 'body')
      .map((l) => l.text as string)
      .join('');
    // A per-chunk decode would show a replacement character that was never sent.
    expect(text).toBe('zażółć');
  });

  it('keeps working when its own file handle fails', async () => {
    const tap = createDebugTap({ dir: tempDir().path });
    await tap.close();
    // Writing after close must be inert, not throw into the request path.
    expect(() =>
      tap.body({ requestId: 'r', hop: 'client', bytes: new Uint8Array([1]) }),
    ).not.toThrow();
    expect(() => tap.end({ requestId: 'r', reason: 'complete', durationMs: 1 })).not.toThrow();
  });
});
