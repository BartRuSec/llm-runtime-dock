/** Structured logging (spec §26). Secrets are never logged. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogValue = string | number | boolean | null | undefined | string[] | LogValue[];

export interface LogFields {
  /** Correlates a log line with one client request. */
  requestId?: string;
  /** Logical model id / runtime instance id. */
  runtime?: string;
  /** Adapter id. */
  adapter?: string;
  /** Backend model the runtime was asked to serve. */
  model?: string;
  /** Lifecycle event name, e.g. `runtime.ready`, `slot.release`. */
  event?: string;
  durationMs?: number;
  queueDepth?: number;
  error?: string;
  errorCode?: string;
  [key: string]: LogValue | undefined;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every line it emits. */
  child(fields: LogFields): Logger;
}

/** Keys whose values are never written to a log line, or to a debug capture. */
export const REDACTED_KEYS = new Set([
  'authorization',
  'api_key',
  'apikey',
  'x-api-key',
  'password',
  'secret',
  'token',
]);

const sanitize = (fields: LogFields): Record<string, LogValue> => {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
};

/**
 * Decorates the parts of a `pretty` line. Plain functions, so core stays free
 * of any terminal dependency — the CLI passes colourisers in, and every other
 * caller gets the identity default.
 */
export interface LogPalette {
  time: (text: string) => string;
  level: (level: LogLevel, text: string) => string;
  message: (text: string) => string;
  fields: (text: string) => string;
}

const PLAIN: LogPalette = {
  time: (text) => text,
  level: (_level, text) => text,
  message: (text) => text,
  fields: (text) => text,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** `json` for machine consumption, `pretty` for a terminal. */
  format?: 'json' | 'pretty';
  write?: (line: string) => void;
  base?: LogFields;
  /** Styling for `pretty` output only; `json` is never decorated. */
  palette?: LogPalette;
}

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const base = options.base ?? {};
  const palette = options.palette ?? PLAIN;

  const emit = (lvl: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const merged = sanitize({ ...base, ...fields });
    const time = new Date().toISOString();
    if (format === 'json') {
      write(JSON.stringify({ time, level: lvl, msg: message, ...merged }));
      return;
    }
    const extras = Object.entries(merged)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
      .join(' ');
    // Padded before it is decorated: a colourised level would count its escape
    // bytes towards the width and shift every following column.
    const badge = palette.level(lvl, lvl.toUpperCase().padEnd(5));
    const tail = extras ? ` ${palette.fields(extras)}` : '';
    write(`${palette.time(time)} ${badge} ${palette.message(message)}${tail}`);
  };

  const logger: Logger = {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
  return logger;
};

/** A logger that discards everything. Useful in tests and pure CLI paths. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
