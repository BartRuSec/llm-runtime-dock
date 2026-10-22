import { StringDecoder } from 'node:string_decoder';
import type {
  RequestTap,
  TapBody,
  TapEnd,
  TapUpstreamRequest,
  TapUpstreamResponse,
} from './proxy.js';

/**
 * Per-model token counters, read off what the upstream already says.
 *
 * A passive `RequestTap`, so it inherits the tee rule: it never alters a byte
 * and every method swallows its own failures. It reads `usage` and nothing
 * else — the gateway does not inject `stream_options` or any other field to
 * make a response countable, so an OpenAI stream whose client did not ask for
 * `include_usage` carries no numbers. Those requests are counted in
 * `noUsage` rather than estimated, which would be a guess
 * presented as a measurement.
 *
 * Counters are keyed by the logical entry id and live in memory only: they
 * reset when the gateway restarts, and `since` says when that was.
 */

export interface ModelUsage {
  /** Requests that completed with a 2xx answer. */
  requests: number;
  /** Every prompt token served, cache hits included (see `cached`). */
  input: number;
  output: number;
  /** The part of `input` the runtime answered from its prompt cache. */
  cached: number;
  /** Completed requests whose response reported no `usage` at all. */
  noUsage: number;
  /** Cancelled, errored or non-2xx. Their tokens are not added to the totals. */
  failed: number;
}

export interface UsageSnapshot {
  /** ISO timestamp of when counting began, i.e. when the gateway started. */
  readonly since: string;
  readonly models: Readonly<Record<string, Readonly<ModelUsage>>>;
}

export interface UsageTap extends RequestTap {
  snapshot(): UsageSnapshot;
}

export interface UsageTapOptions {
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Cap on a buffered non-streaming body, in bytes. Past it the request counts as unreported. */
  readonly maxJsonBytes?: number;
}

const DEFAULT_MAX_JSON_BYTES = 8_388_608;
/** A single SSE line longer than this is not a usage event worth waiting for. */
const MAX_LINE_CARRY = 1_048_576;

interface RequestState {
  readonly runtime: string;
  status: number;
  sse: boolean;
  decoder: StringDecoder;
  /** SSE: the unterminated tail of the last chunk. JSON: the whole body so far. */
  carry: string;
  carryBytes: number;
  overflowed: boolean;
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
  cacheCreation: number | undefined;
  /**
   * Anthropic reports cache traffic *beside* `input_tokens`, OpenAI *inside*
   * `prompt_tokens`. Which one this response used decides the sum.
   */
  additive: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const headerValue = (headers: Readonly<Record<string, string>>, name: string): string => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return '';
};

const raise = (current: number | undefined, next: number | undefined): number | undefined =>
  next === undefined ? current : Math.max(current ?? 0, next);

/**
 * Fold one parsed JSON value into the request's totals.
 *
 * `usage` sits at the top level for OpenAI bodies and chunks and for Anthropic
 * `message_delta`, and under `message` for Anthropic `message_start`. Every
 * figure is cumulative, so the largest seen wins rather than being summed — and
 * rather than the last, because a runtime may open with zeros in
 * `message_start` and report the real numbers in `message_delta`, or repeat a
 * zero there. A field that is absent leaves the earlier one alone.
 *
 * Cache traffic needs care. An Anthropic response splits the prompt into
 * `input_tokens` (not cached), `cache_read_input_tokens` and
 * `cache_creation_input_tokens`; a prefix-cache hit on a runtime therefore
 * reports `input_tokens: 0` and the whole prompt under `cache_read`. Counting
 * `input_tokens` alone would read as no input at all. OpenAI's `prompt_tokens`
 * already contains the cached part, which `prompt_tokens_details` names.
 */
const absorb = (state: RequestState, value: unknown): void => {
  if (!isRecord(value)) return;
  const message = value['message'];
  const holders = [value['usage'], isRecord(message) ? message['usage'] : undefined];
  for (const usage of holders) {
    if (!isRecord(usage)) continue;
    const details = usage['prompt_tokens_details'];
    const openai = count(usage['prompt_tokens']);
    const anthropic = count(usage['input_tokens']);
    if (anthropic !== undefined) state.additive = true;
    state.input = raise(state.input, openai ?? anthropic);
    state.output = raise(
      state.output,
      count(usage['completion_tokens']) ?? count(usage['output_tokens']),
    );
    state.cacheRead = raise(
      state.cacheRead,
      count(usage['cache_read_input_tokens']) ??
        (isRecord(details) ? count(details['cached_tokens']) : undefined),
    );
    state.cacheCreation = raise(state.cacheCreation, count(usage['cache_creation_input_tokens']));
  }
};

const absorbText = (state: RequestState, text: string): void => {
  try {
    absorb(state, JSON.parse(text));
  } catch {
    // Not JSON, or a truncated line: nothing to count, and nothing to report.
  }
};

const absorbLine = (state: RequestState, rawLine: string): void => {
  const line = rawLine.trim();
  if (!line.startsWith('data:') || !line.includes('"usage"')) return;
  const payload = line.slice('data:'.length).trim();
  if (payload === '[DONE]') return;
  absorbText(state, payload);
};

export const createUsageTap = (options: UsageTapOptions = {}): UsageTap => {
  const now = options.now ?? ((): Date => new Date());
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  const since = now().toISOString();
  const requests = new Map<string, RequestState>();
  const totals = new Map<string, ModelUsage>();

  const usageOf = (runtime: string): ModelUsage => {
    const existing = totals.get(runtime);
    if (existing) return existing;
    const created: ModelUsage = {
      requests: 0,
      input: 0,
      output: 0,
      cached: 0,
      noUsage: 0,
      failed: 0,
    };
    totals.set(runtime, created);
    return created;
  };

  return {
    upstreamRequest: (entry: TapUpstreamRequest): void => {
      try {
        // A token-counting call is not served usage: nothing was generated.
        if (entry.path === 'messages/count_tokens') return;
        requests.set(entry.requestId, {
          runtime: entry.runtime,
          status: 0,
          sse: false,
          decoder: new StringDecoder('utf8'),
          carry: '',
          carryBytes: 0,
          overflowed: false,
          input: undefined,
          output: undefined,
          cacheRead: undefined,
          cacheCreation: undefined,
          additive: false,
        });
      } catch {
        // A tee never throws into the request path.
      }
    },

    upstreamResponse: (entry: TapUpstreamResponse): void => {
      try {
        const state = requests.get(entry.requestId);
        if (!state) return;
        state.status = entry.status;
        state.sse = headerValue(entry.headers, 'content-type').includes('text/event-stream');
      } catch {
        // See above.
      }
    },

    body: (entry: TapBody): void => {
      try {
        if (entry.hop !== 'upstream') return;
        const state = requests.get(entry.requestId);
        if (!state || state.status < 200 || state.status >= 300 || state.overflowed) return;
        const text = state.decoder.write(Buffer.from(entry.bytes));
        if (state.sse) {
          const lines = (state.carry + text).split('\n');
          state.carry = lines.pop() ?? '';
          for (const line of lines) absorbLine(state, line);
          if (state.carry.length > MAX_LINE_CARRY) state.carry = '';
          return;
        }
        state.carryBytes += entry.bytes.byteLength;
        if (state.carryBytes > maxJsonBytes) {
          state.overflowed = true;
          state.carry = '';
          return;
        }
        state.carry += text;
      } catch {
        // See above.
      }
    },

    end: (entry: TapEnd): void => {
      try {
        const state = requests.get(entry.requestId);
        if (!state) return;
        requests.delete(entry.requestId);
        const usage = usageOf(state.runtime);
        if (entry.reason !== 'complete' || state.status < 200 || state.status >= 300) {
          usage.failed += 1;
          return;
        }
        if (state.sse) {
          absorbLine(state, state.carry + state.decoder.end());
        } else if (!state.overflowed) {
          absorbText(state, state.carry + state.decoder.end());
        }
        usage.requests += 1;
        const reported = [state.input, state.output, state.cacheRead, state.cacheCreation];
        if (reported.every((figure) => figure === undefined)) {
          usage.noUsage += 1;
          return;
        }
        const cacheRead = state.cacheRead ?? 0;
        const beside = state.additive ? cacheRead + (state.cacheCreation ?? 0) : 0;
        usage.input += (state.input ?? 0) + beside;
        usage.output += state.output ?? 0;
        usage.cached += cacheRead;
      } catch {
        // See above.
      }
    },

    snapshot: (): UsageSnapshot => ({
      since,
      models: Object.fromEntries([...totals].map(([id, usage]) => [id, { ...usage }])),
    }),
  };
};

/**
 * Several taps behind the one slot `proxyRequest` has. Each is called in turn
 * and one that throws cannot stop the others — they are all tees.
 */
export const fanoutTap = (...taps: readonly RequestTap[]): RequestTap => {
  const each = (call: (tap: RequestTap) => void): void => {
    for (const tap of taps) {
      try {
        call(tap);
      } catch {
        // Instruments must not break each other, let alone the request.
      }
    }
  };
  return {
    upstreamRequest: (entry) => each((tap) => tap.upstreamRequest(entry)),
    upstreamResponse: (entry) => each((tap) => tap.upstreamResponse(entry)),
    body: (entry) => each((tap) => tap.body(entry)),
    end: (entry) => each((tap) => tap.end(entry)),
  };
};
