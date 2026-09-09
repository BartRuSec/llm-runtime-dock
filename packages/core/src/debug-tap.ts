import { createWriteStream, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from './logging.js';
import { nullLogger, REDACTED_KEYS } from './logging.js';
import type {
  RequestTap,
  TapBody,
  TapEnd,
  TapUpstreamRequest,
  TapUpstreamResponse,
} from './proxy.js';

/**
 * `lrd serve --debug`: a file-backed `RequestTap` (§14).
 *
 * One NDJSON file per serve session, one line per event. This is the artefact
 * that answers "did the gateway change my request" with bytes instead of
 * argument — so it records what went upstream *after* model resolution, and
 * both what the upstream answered and what survived the response filter.
 *
 * Three properties it must not lose:
 *
 * - **It is a tee.** Every method swallows its own failures. A capture that can
 *   break the request it observes is worse than no capture.
 * - **It redacts.** Credentials arrive verbatim in the headers.
 * - **It is bounded.** One agent request carries the whole conversation, and
 *   half a megabyte of transcript is ordinary, so bodies are capped per hop and
 *   the truncation is recorded rather than silent.
 */

export interface DebugTapOptions {
  /** Directory for the capture file. Defaults to a subdirectory of the temp dir. */
  readonly dir?: string;
  /** Per-request, per-hop body budget in bytes. */
  readonly maxBodyBytes?: number;
  readonly logger?: Logger;
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

export interface DebugTap extends RequestTap {
  /** Where the capture is being written. */
  readonly path: string;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Replace the value of any header whose name names a secret. */
const redactHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = REDACTED_KEYS.has(name.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
};

interface HopState {
  written: number;
  truncated: boolean;
  seq: number;
  decoder: StringDecoder;
}

export const createDebugTap = (options: DebugTapOptions = {}): DebugTap => {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? ((): Date => new Date());
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Never a `/tmp` literal: Windows is a supported target.
  const dir = options.dir ?? join(tmpdir(), 'llm-runtime-dock');
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `capture-${stamp}-${process.pid}.ndjson`);

  mkdirSync(dir, { recursive: true });
  let stream: WriteStream | null = createWriteStream(path, { flags: 'a' });
  stream.on('error', (error: Error) => {
    // One report, then the tap goes quiet. It must never take the gateway down
    // with it, and a per-chunk warning would drown the log it exists to help.
    logger.warn('debug capture disabled', { event: 'debug.write_error', error: error.message });
    stream = null;
  });

  /** Body accounting, keyed by `<requestId> <hop>`. */
  const hops = new Map<string, HopState>();

  const emit = (event: string, fields: Record<string, unknown>): void => {
    if (!stream) return;
    try {
      stream.write(`${JSON.stringify({ t: now().toISOString(), event, ...fields })}\n`);
    } catch {
      // Serialization trouble or a closed handle: dropping the line is the only
      // safe answer, because throwing here would surface in the request path.
    }
  };

  const hopState = (requestId: string, hop: string): HopState => {
    const key = `${requestId} ${hop}`;
    const existing = hops.get(key);
    if (existing) return existing;
    const created: HopState = {
      written: 0,
      truncated: false,
      seq: 0,
      decoder: new StringDecoder('utf8'),
    };
    hops.set(key, created);
    return created;
  };

  /**
   * Record one body slice against its hop's budget.
   *
   * Chunk boundaries can split a multi-byte character, so text is decoded
   * through a stateful decoder rather than per chunk — otherwise a capture of
   * non-ASCII content shows replacement characters that were never on the wire.
   */
  const recordBody = (requestId: string, hop: string, bytes: Uint8Array): void => {
    const state = hopState(requestId, hop);
    const text = state.decoder.write(Buffer.from(bytes));
    if (state.truncated) return;
    if (state.written >= maxBodyBytes) {
      state.truncated = true;
      emit('body', { requestId, hop, truncated: true, limitBytes: maxBodyBytes });
      return;
    }
    state.written += bytes.byteLength;
    emit('body', { requestId, hop, seq: state.seq++, text, bytes: bytes.byteLength });
  };

  const forget = (requestId: string): void => {
    for (const hop of ['upstream', 'client']) hops.delete(`${requestId} ${hop}`);
  };

  return {
    path,

    upstreamRequest: (entry: TapUpstreamRequest): void => {
      const body =
        entry.body.length > maxBodyBytes ? entry.body.slice(0, maxBodyBytes) : entry.body;
      emit('request', {
        requestId: entry.requestId,
        path: entry.path,
        url: entry.url,
        runtime: entry.runtime,
        adapter: entry.adapter,
        servedModel: entry.servedModel,
        headers: redactHeaders(entry.headers),
        body,
        bodyChars: entry.body.length,
        truncated: body.length !== entry.body.length,
      });
    },

    upstreamResponse: (entry: TapUpstreamResponse): void => {
      emit('response', {
        requestId: entry.requestId,
        status: entry.status,
        headers: redactHeaders(entry.headers),
        forwarded: redactHeaders(entry.forwarded),
        durationMs: entry.durationMs,
      });
    },

    body: (entry: TapBody): void => {
      recordBody(entry.requestId, entry.hop, entry.bytes);
    },

    end: (entry: TapEnd): void => {
      emit('end', {
        requestId: entry.requestId,
        reason: entry.reason,
        durationMs: entry.durationMs,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      });
      forget(entry.requestId);
    },

    close: async (): Promise<void> => {
      const open = stream;
      stream = null;
      if (!open) return;
      await new Promise<void>((resolve) => open.end(() => resolve()));
    },
  };
};
