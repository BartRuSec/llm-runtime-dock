import pc from 'picocolors';

/**
 * Terminal styling for the CLI (spec §27).
 *
 * Colour is decided once, in `createCliContext`, and reaches a command only as
 * this object. No file under `commands/` imports a colouriser: a module-scope
 * `pc.green(...)` would ignore the per-context switch and start leaking escape
 * sequences into `--json`.
 *
 * The one rule every caller has to keep: **pad first, colour second**. Every
 * width in this CLI is computed from `String.length`, which counts escape
 * bytes, so colouring a cell before aligning it silently breaks the column.
 * `output.ts` encodes that ordering so callers do not have to.
 */

export interface Theme {
  /** Whether anything below actually emits escape sequences. */
  readonly enabled: boolean;
  /** Section titles and table headers. */
  heading: (text: string) => string;
  /** Field labels: `Gateway:`, `Config:`, an option term in help. */
  label: (text: string) => string;
  /** A logical model id, a command name — the thing a user would retype. */
  id: (text: string) => string;
  path: (text: string) => string;
  url: (text: string) => string;
  /** Comments, hints, `(none)` — present but not the point. */
  muted: (text: string) => string;
  ok: (text: string) => string;
  warn: (text: string) => string;
  danger: (text: string) => string;
  /** A lifecycle state, coloured by what it means rather than by its spelling. */
  state: (state: string) => string;
  /** A `doctor` finding level. ASCII, never a symbol — see §Cross-platform. */
  level: (level: 'ok' | 'warn' | 'error', text: string) => string;
}

export const createTheme = (enabled: boolean): Theme => {
  // `createColors(false)` returns the same shape with identity functions, so
  // nothing downstream needs a second code path for the plain case.
  const c = pc.createColors(enabled);

  const state = (value: string): string => {
    if (value === 'ready') return c.green(value);
    if (value === 'loading' || value === 'starting' || value === 'stopping') return c.yellow(value);
    if (value === 'error' || value === 'unreachable') return c.red(value);
    return c.dim(value);
  };

  return {
    enabled,
    heading: (text) => c.bold(text),
    label: (text) => c.cyan(text),
    id: (text) => c.bold(text),
    path: (text) => c.magenta(text),
    url: (text) => c.underline(c.blue(text)),
    muted: (text) => c.dim(text),
    ok: (text) => c.green(text),
    warn: (text) => c.yellow(text),
    danger: (text) => c.red(text),
    state,
    level: (level, text) => {
      if (level === 'ok') return c.green(text);
      if (level === 'warn') return c.yellow(text);
      return c.red(text);
    },
  };
};

export interface ColorInput {
  readonly json?: boolean | undefined;
  readonly noColor?: boolean | undefined;
  /**
   * Skips the terminal detection below. Tests use it to assert on styled
   * output without a TTY; it deliberately does **not** override `--no-color`,
   * `NO_COLOR` or `--json`, which are refusals rather than preferences.
   */
  readonly force?: boolean | undefined;
  /**
   * Whether this run owns the process streams. A caller that injected its own
   * writers gets plain text: we have no idea what is on the other end, and
   * every test in this repository injects a pair of array collectors.
   */
  readonly ownsStreams: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly isTty: boolean;
}

/**
 * Whether to colour, decided from explicit inputs rather than from the ambient
 * process. `picocolors.isColorSupported` snapshots `process.env` at import
 * time, and the context carries an injected `env`, so this resolves its own.
 */
export const resolveColor = (input: ColorInput): boolean => {
  if (input.noColor === true) return false;
  // Any non-empty NO_COLOR means no colour: https://no-color.org
  if ((input.env.NO_COLOR ?? '') !== '') return false;
  if (input.json === true) return false;
  if (input.force !== undefined) return input.force;
  if (!input.ownsStreams) return false;
  if (input.env.TERM === 'dumb') return false;

  const force = input.env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    return force !== '0' && force !== 'false' && force !== 'off';
  }
  return input.isTty;
};
