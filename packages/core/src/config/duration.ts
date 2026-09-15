import { cliError } from '../errors.js';

/**
 * Durations a person types, resolved to milliseconds (spec §12).
 *
 * Every other duration in this file format is an integer `*_ms` field, and those
 * are plumbing — a custom adapter's `startup_timeout_ms`, a health block's
 * `timeout_ms`. `server.idle_unload` is not plumbing: it is the one duration a
 * user actually chooses, and `3600000` is a hostile way to write an hour. So a
 * unit suffix is accepted and a bare number still means milliseconds, which
 * keeps the existing convention true rather than replacing it.
 *
 * `off` is deliberately **not** a spelling of zero. Unquoted, some YAML parsers
 * read it as the boolean `false` — the same trap §12 already warns about for
 * `on`/`off` option values — so a config that looked disabled would fail to
 * parse instead. `0` is unambiguous in every parser.
 */

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const SPELLING = '3600000, 3600000ms, 3600s, 60m or 1h; 0 disables';

/**
 * Parse a duration into milliseconds. `field` is the YAML path, so the message
 * names the key the user has to fix rather than the value it choked on.
 */
export const parseDuration = (value: unknown, field: string): number => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw cliError('CONFIG_INVALID', `${field} must be a whole number of milliseconds or more`, {
        details: { field, value: String(value) },
        hint: `accepted: ${SPELLING}`,
      });
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw cliError('CONFIG_INVALID', `${field} must be a duration`, {
      details: { field, type: typeof value },
      hint: `accepted: ${SPELLING}`,
    });
  }
  // `.match`, not `.exec`: the lint rule that bans `child_process.exec` reads
  // the call by name and cannot tell a regexp apart from a process spawn.
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!match) {
    throw cliError('CONFIG_INVALID', `${field} is not a duration: "${value}"`, {
      details: { field, value },
      hint: `accepted: ${SPELLING}`,
    });
  }
  // A bare number of milliseconds when no unit is given, matching every `*_ms`
  // field in this schema.
  return Number(match[1]) * UNIT_MS[(match[2] ?? 'ms').toLowerCase()]!;
};

/**
 * The inverse, for the CLI's own report. Exact units only — an idle window is
 * always written as a round number of something, so `90s` never has to become
 * "1.5m", and a value that divides nothing falls back to milliseconds.
 */
export const formatDuration = (ms: number): string => {
  if (ms <= 0) return 'off';
  for (const unit of ['h', 'm', 's'] as const) {
    const size = UNIT_MS[unit]!;
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
};
