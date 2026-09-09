import { describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/**
 * Command-line UX (spec §27).
 *
 * pnpm forwards the literal `--` from `pnpm dev -- probe` into argv. Left in
 * place it turns every following token into a positional operand, so `--help`
 * would be read as a command name.
 */

const harness = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    // No adapters needed: these exercise parsing, not orchestration.
    run: (argv: string[]) =>
      runCli({
        argv,
        adapters: [],
        agents: [],
        stdout: (l) => out.push(l),
        stderr: (l) => err.push(l),
      }),
  };
};

/** Mirrors the composition root's separator handling. */
const stripArgSeparator = (args: readonly string[]): string[] => {
  return args[0] === '--' ? args.slice(1) : [...args];
};

describe('argument separator handling', () => {
  it('drops one leading separator so flags after it stay flags', () => {
    expect(stripArgSeparator(['--', 'probe', '--help'])).toEqual(['probe', '--help']);
    expect(stripArgSeparator(['probe', 'mtplx'])).toEqual(['probe', 'mtplx']);
    expect(stripArgSeparator([])).toEqual([]);
    // Only the first is dropped; a second is a real argument.
    expect(stripArgSeparator(['--', '--'])).toEqual(['--']);
  });

  it('parses a subcommand identically with and without the separator', async () => {
    const a = harness();
    const b = harness();
    const codeA = await a.run(stripArgSeparator(['--', 'models', '--config', '/nope.yaml']));
    const codeB = await b.run(stripArgSeparator(['models', '--config', '/nope.yaml']));

    expect(codeA).toBe(codeB);
    expect(a.err.join('\n')).toBe(b.err.join('\n'));
    expect(a.err.join('\n')).toContain('CONFIG_INVALID');
    // Not "unknown command", which is what a stray separator would produce.
    expect(a.err.join('\n')).not.toContain('unknown command');
  });
});

describe('command surface', () => {
  it('exposes every documented command', async () => {
    const h = harness();
    await h.run(['--help']);
    const help = h.out.join('\n');
    for (const command of [
      'serve',
      'status',
      'probe',
      'apply',
      'doctor',
      'models',
      'runtimes',
      'switch',
      'logs',
    ]) {
      expect(help).toContain(command);
    }
  });

  it('accepts --config and --json on either side of the subcommand', async () => {
    for (const argv of [
      ['--config', '/nope.yaml', 'models'],
      ['models', '--config', '/nope.yaml'],
    ]) {
      const h = harness();
      const code = await h.run(argv);
      expect(code).toBe(1);
      expect(h.err.join('\n')).toContain('CONFIG_INVALID');
    }
  });

  it('routes commander output through the injected writers', async () => {
    const h = harness();
    const code = await h.run(['definitely-not-a-command']);
    expect(code).toBe(1);
    // Nothing may leak straight to process.stderr; a caller owns every stream.
    expect(h.err.join('\n')).toContain('unknown command');
  });

  it('fails readably when no gateway answers, without a stack trace', async () => {
    const h = harness();
    const code = await h.run(['status', '--endpoint', 'http://127.0.0.1:59999']);
    expect(code).toBe(1);
    const message = h.err.join('\n');
    expect(message).toContain('GATEWAY_NOT_RUNNING');
    expect(message).toContain('gateway not running');
    expect(message).not.toContain('at Object.');
  });
});
