import { describe, expect, it } from 'vitest';
import { createUsageTap, fanoutTap, type RequestTap, type UsageTap } from '../src/index.js';

/**
 * Per-model token counters read from what the upstream reported. The tap is
 * driven directly, one hop at a time, the way `proxyRequest` drives it.
 */

const encoder = new TextEncoder();

interface Call {
  readonly id?: string;
  readonly runtime?: string;
  readonly path?: 'chat/completions' | 'messages' | 'messages/count_tokens';
  readonly status?: number;
  readonly contentType?: string;
  readonly chunks: readonly (string | Uint8Array)[];
  readonly reason?: 'complete' | 'cancelled' | 'error';
}

const drive = (tap: RequestTap, call: Call): void => {
  const requestId = call.id ?? 'req-1';
  tap.upstreamRequest({
    requestId,
    path: call.path ?? 'chat/completions',
    url: 'http://127.0.0.1:8000/v1/chat/completions',
    runtime: call.runtime ?? 'quality',
    adapter: 'stub',
    servedModel: 'served',
    headers: {},
    body: '{}',
  });
  tap.upstreamResponse({
    requestId,
    status: call.status ?? 200,
    headers: { 'Content-Type': call.contentType ?? 'application/json' },
    forwarded: {},
    durationMs: 1,
  });
  for (const chunk of call.chunks) {
    tap.body({
      requestId,
      hop: 'upstream',
      bytes: typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
    });
  }
  tap.end({ requestId, reason: call.reason ?? 'complete', durationMs: 1 });
};

const sse = 'text/event-stream';
const usageOf = (tap: UsageTap, id = 'quality') => tap.snapshot().models[id];

describe('createUsageTap', () => {
  it('reads usage from an OpenAI JSON body', () => {
    const tap = createUsageTap();
    drive(tap, {
      chunks: [
        JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } }),
      ],
    });
    expect(usageOf(tap)).toEqual({
      requests: 1,
      input: 12,
      output: 34,
      cached: 0,
      noUsage: 0,
      failed: 0,
    });
  });

  it('reads the final usage chunk of an OpenAI stream', () => {
    const tap = createUsageTap();
    drive(tap, {
      contentType: sse,
      chunks: [
        'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ],
    });
    expect(usageOf(tap)).toMatchObject({ requests: 1, input: 5, output: 7 });
  });

  it('counts an OpenAI stream with no usage as unreported, not as zero tokens', () => {
    const tap = createUsageTap();
    drive(tap, {
      contentType: sse,
      chunks: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'],
    });
    expect(usageOf(tap)).toMatchObject({
      requests: 1,
      input: 0,
      output: 0,
      noUsage: 1,
    });
  });

  it('takes Anthropic input from message_start and the last output from message_delta', () => {
    const tap = createUsageTap();
    drive(tap, {
      path: 'messages',
      contentType: sse,
      chunks: [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
      ],
    });
    // Cumulative, so 42 — not 1 + 20 + 42.
    expect(usageOf(tap)).toMatchObject({ input: 100, output: 42 });
  });

  it('counts a prefix-cache hit as input, the way mtplx reports it', () => {
    const tap = createUsageTap();
    // Captured from a real mtplx: a repeated prompt answers `input_tokens: 0`
    // and puts the whole prompt under `cache_read_input_tokens`.
    drive(tap, {
      path: 'messages',
      chunks: [
        JSON.stringify({
          usage: { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 2015 },
        }),
      ],
    });
    expect(usageOf(tap)).toMatchObject({ input: 2015, output: 4, cached: 2015, noUsage: 0 });
  });

  it('adds cache creation to Anthropic input but not to cached', () => {
    const tap = createUsageTap();
    drive(tap, {
      path: 'messages',
      chunks: [
        JSON.stringify({
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        }),
      ],
    });
    expect(usageOf(tap)).toMatchObject({ input: 160, output: 2, cached: 100 });
  });

  it('does not add OpenAI cached tokens twice, since prompt_tokens already holds them', () => {
    const tap = createUsageTap();
    drive(tap, {
      chunks: [
        JSON.stringify({
          usage: {
            prompt_tokens: 300,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 256 },
          },
        }),
      ],
    });
    expect(usageOf(tap)).toMatchObject({ input: 300, output: 5, cached: 256 });
  });

  it('keeps real numbers when message_start opens at zero and message_delta repeats a zero', () => {
    const tap = createUsageTap();
    drive(tap, {
      path: 'messages',
      contentType: sse,
      chunks: [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":12,"output_tokens":16,"cache_read_input_tokens":0}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":0,"output_tokens":16}}\n\n',
      ],
    });
    expect(usageOf(tap)).toMatchObject({ input: 12, output: 16 });
  });

  it('reads an Anthropic JSON body', () => {
    const tap = createUsageTap();
    drive(tap, {
      path: 'messages',
      chunks: [JSON.stringify({ usage: { input_tokens: 8, output_tokens: 9 } })],
    });
    expect(usageOf(tap)).toMatchObject({ input: 8, output: 9 });
  });

  it('survives a usage line split across chunks, including inside a multi-byte character', () => {
    const tap = createUsageTap();
    const bytes = encoder.encode(
      'data: {"note":"zażółć","usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
    );
    // Cut inside the two-byte `ż`.
    const cut = bytes.indexOf(0xc5) + 1;
    drive(tap, {
      contentType: sse,
      chunks: [bytes.slice(0, cut), bytes.slice(cut, cut + 9), bytes.slice(cut + 9)],
    });
    expect(usageOf(tap)).toMatchObject({ input: 3, output: 4 });
  });

  it('reads a final SSE line that has no trailing newline', () => {
    const tap = createUsageTap();
    drive(tap, {
      contentType: sse,
      chunks: ['data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}'],
    });
    expect(usageOf(tap)).toMatchObject({ input: 1, output: 2 });
  });

  it('ignores token-counting calls', () => {
    const tap = createUsageTap();
    drive(tap, { path: 'messages/count_tokens', chunks: ['{"input_tokens":99}'] });
    expect(tap.snapshot().models).toEqual({});
  });

  it('keeps failed requests out of the token totals', () => {
    const tap = createUsageTap();
    const body = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } });
    drive(tap, { id: 'a', reason: 'cancelled', chunks: [body] });
    drive(tap, { id: 'b', reason: 'error', chunks: [body] });
    drive(tap, { id: 'c', status: 500, chunks: [body] });
    expect(usageOf(tap)).toEqual({
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      noUsage: 0,
      failed: 3,
    });
  });

  it('keys totals by the logical entry and accumulates across requests', () => {
    const tap = createUsageTap();
    const body = (p: number, c: number): string =>
      JSON.stringify({ usage: { prompt_tokens: p, completion_tokens: c } });
    drive(tap, { id: 'a', runtime: 'quality', chunks: [body(1, 2)] });
    drive(tap, { id: 'b', runtime: 'quality', chunks: [body(3, 4)] });
    drive(tap, { id: 'c', runtime: 'fast', chunks: [body(5, 6)] });
    expect(usageOf(tap)).toMatchObject({ requests: 2, input: 4, output: 6 });
    expect(usageOf(tap, 'fast')).toMatchObject({
      requests: 1,
      input: 5,
      output: 6,
    });
  });

  it('counts a body past the buffering cap as unreported', () => {
    const tap = createUsageTap({ maxJsonBytes: 16 });
    drive(tap, {
      chunks: [JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } })],
    });
    expect(usageOf(tap)).toMatchObject({ requests: 1, noUsage: 1 });
  });

  it('ignores the client hop and forgets a request once it ends', () => {
    const tap = createUsageTap();
    tap.upstreamRequest({
      requestId: 'r',
      path: 'chat/completions',
      url: '',
      runtime: 'quality',
      adapter: 'stub',
      servedModel: 's',
      headers: {},
      body: '',
    });
    tap.upstreamResponse({
      requestId: 'r',
      status: 200,
      headers: {},
      forwarded: {},
      durationMs: 1,
    });
    tap.body({
      requestId: 'r',
      hop: 'client',
      bytes: encoder.encode('{"usage":{"prompt_tokens":9,"completion_tokens":9}}'),
    });
    tap.end({ requestId: 'r', reason: 'complete', durationMs: 1 });
    // A second end for the same id has nothing left to attribute.
    tap.end({ requestId: 'r', reason: 'complete', durationMs: 1 });
    expect(usageOf(tap)).toMatchObject({ requests: 1, input: 0, noUsage: 1 });
  });

  it('treats a non-integer, negative or unsafe value as not reported', () => {
    const tap = createUsageTap();
    drive(tap, {
      chunks: [JSON.stringify({ usage: { prompt_tokens: 1e300, completion_tokens: 1.5 } })],
    });
    drive(tap, {
      id: 'b',
      chunks: [JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: 2 ** 53 } })],
    });
    expect(usageOf(tap)).toMatchObject({ requests: 2, input: 0, output: 0, noUsage: 2 });
  });

  it('stamps when counting began', () => {
    const tap = createUsageTap({ now: () => new Date('2026-01-02T03:04:05.000Z') });
    expect(tap.snapshot().since).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('fanoutTap', () => {
  it('forwards every event to every tap and survives one that throws', () => {
    const seen: string[] = [];
    const recorder = (name: string): RequestTap => ({
      upstreamRequest: () => seen.push(`${name}:req`),
      upstreamResponse: () => seen.push(`${name}:res`),
      body: () => seen.push(`${name}:body`),
      end: () => seen.push(`${name}:end`),
    });
    const broken: RequestTap = {
      upstreamRequest: () => {
        throw new Error('boom');
      },
      upstreamResponse: () => {
        throw new Error('boom');
      },
      body: () => {
        throw new Error('boom');
      },
      end: () => {
        throw new Error('boom');
      },
    };
    drive(fanoutTap(broken, recorder('a'), recorder('b')), { chunks: ['{}'] });
    expect(seen).toEqual([
      'a:req',
      'b:req',
      'a:res',
      'b:res',
      'a:body',
      'b:body',
      'a:end',
      'b:end',
    ]);
  });
});
