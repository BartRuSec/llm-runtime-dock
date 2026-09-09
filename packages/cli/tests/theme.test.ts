import { describe, expect, it } from 'vitest';
import { columns, keyValue, labelWidth } from '../src/output.js';
import { createTheme, resolveColor } from '../src/theme.js';
import { runCli } from '../src/index.js';

/**
 * Terminal styling (spec §27).
 *
 * The invariant every test here defends: colour is decoration only. Strip the
 * escape sequences back off and the bytes must be what the plain run produced,
 * because every column in this CLI is aligned with `padEnd` on raw lengths.
 */

/** Local, so no `strip-ansi` dependency reaches the published bundle. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (text: string): string => text.replace(ANSI, '');

const base = {
  ownsStreams: true,
  env: {} as NodeJS.ProcessEnv,
  isTty: true,
};

describe('resolveColor', () => {
  it('colours a terminal this run owns', () => {
    expect(resolveColor(base)).toBe(true);
  });

  it('stays plain whenever something says not to', () => {
    expect(resolveColor({ ...base, ownsStreams: false })).toBe(false);
    expect(resolveColor({ ...base, noColor: true })).toBe(false);
    expect(resolveColor({ ...base, json: true })).toBe(false);
    expect(resolveColor({ ...base, isTty: false })).toBe(false);
    expect(resolveColor({ ...base, env: { NO_COLOR: '1' } })).toBe(false);
    expect(resolveColor({ ...base, env: { TERM: 'dumb' } })).toBe(false);
  });

  it('treats an empty NO_COLOR as unset', () => {
    expect(resolveColor({ ...base, env: { NO_COLOR: '' } })).toBe(true);
  });

  it('lets force skip the terminal detection but not an explicit refusal', () => {
    expect(resolveColor({ ...base, ownsStreams: false, isTty: false, force: true })).toBe(true);
    expect(resolveColor({ ...base, force: false })).toBe(false);
    // A refusal is not a preference: these outrank force in both directions.
    expect(resolveColor({ ...base, force: true, noColor: true })).toBe(false);
    expect(resolveColor({ ...base, force: true, json: true })).toBe(false);
    expect(resolveColor({ ...base, force: true, env: { NO_COLOR: '1' } })).toBe(false);
  });

  it('lets FORCE_COLOR override a missing terminal, and its off-spellings win', () => {
    expect(resolveColor({ ...base, isTty: false, env: { FORCE_COLOR: '1' } })).toBe(true);
    for (const off of ['0', 'false', 'off']) {
      expect(resolveColor({ ...base, env: { FORCE_COLOR: off } })).toBe(false);
    }
  });

  it('keeps NO_COLOR ahead of FORCE_COLOR', () => {
    // The documented way to turn colour off must not be defeated by an
    // environment that happens to also carry FORCE_COLOR.
    expect(resolveColor({ ...base, env: { NO_COLOR: '1', FORCE_COLOR: '1' } })).toBe(false);
  });
});

describe('column layout', () => {
  const headers = ['MODEL', 'ADAPTER', 'STATE'];
  const rows = [
    ['coding-quality', 'mtplx', 'ready'],
    ['x', 'lm-studio', 'stopped'],
  ];

  it('aligns identically with and without colour', () => {
    const theme = createTheme(true);
    const plain = columns(headers, rows);
    const coloured = columns(headers, rows, [theme.id, theme.muted, theme.state], theme.heading);

    expect(coloured.some((line) => line.includes('\x1b'))).toBe(true);
    expect(coloured.map(strip)).toEqual(plain);
  });

  it('pads every column to its widest cell and never trails whitespace', () => {
    const [header, first] = columns(headers, rows);
    expect(header).toBe('MODEL           ADAPTER    STATE');
    expect(first).toBe('coding-quality  mtplx      ready');
    for (const line of columns(headers, rows)) expect(line).toBe(line.trimEnd());
  });
});

describe('keyValue', () => {
  it('reproduces the documented status column', () => {
    const width = labelWidth(['Gateway', 'Config', 'Resident']);
    expect(keyValue('Gateway', 'running', width)).toBe('Gateway:  running');
    expect(keyValue('Resident', 'none', width)).toBe('Resident: none');
  });

  it('styles after padding', () => {
    const theme = createTheme(true);
    const width = labelWidth(['Gateway', 'Resident']);
    const styled = keyValue('Gateway', 'running', width, {
      label: theme.label,
      value: theme.ok,
    });
    expect(styled).toContain('\x1b');
    expect(strip(styled)).toBe(keyValue('Gateway', 'running', width));
  });
});

const capture = (argv: string[], color: boolean) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: () =>
      runCli({
        argv,
        adapters: [],
        agents: [],
        color,
        version: '9.9.9',
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
      }),
  };
};

describe('coloured output is decoration only', () => {
  it('help says the same thing coloured and plain', async () => {
    const coloured = capture(['--help'], true);
    const plain = capture(['--help'], false);
    await coloured.run();
    await plain.run();

    expect(coloured.out.join('\n')).toContain('\x1b');
    expect(strip(coloured.out.join('\n'))).toBe(plain.out.join('\n'));
  });

  it('names the version above the usage line', async () => {
    const help = capture(['--help'], false);
    await help.run();
    expect(help.out.join('\n').startsWith('lrd 9.9.9\n')).toBe(true);

    const version = capture(['--version'], false);
    await version.run();
    expect(version.out.join('\n').trim()).toBe('lrd 9.9.9');
  });

  it('reports a gateway failure the same way, coloured or not', async () => {
    const argv = ['status', '--endpoint', 'http://127.0.0.1:59999'];
    const coloured = capture(argv, true);
    const plain = capture(argv, false);
    expect(await coloured.run()).toBe(1);
    expect(await plain.run()).toBe(1);

    expect(coloured.err.join('\n')).toContain('\x1b');
    expect(strip(coloured.err.join('\n'))).toBe(plain.err.join('\n'));
    expect(plain.err.join('\n')).toContain('error [GATEWAY_NOT_RUNNING]');
  });

  it('never colourises --json, even when colour is forced on', async () => {
    // `--json` is a byte contract: a consumer pipes it into a parser. Help is
    // the one surface that prints on stdout without needing a config.
    const json = capture(['--help', '--json'], true);
    await json.run();
    expect(json.out.join('\n')).not.toContain('\x1b');
  });

  it('honours --no-color on either side of --help', async () => {
    for (const argv of [
      ['--help', '--no-color'],
      ['--no-color', '--help'],
    ]) {
      // Commander acts on `--help` the moment it reaches it, so the flag that
      // follows is never parsed — the raw argv has to be consulted too.
      // Colour forced on, so only the flag itself can be turning it off.
      const h = capture(argv, true);
      await h.run();
      expect(h.out.join('\n')).not.toContain('\x1b');
    }
  });
});
