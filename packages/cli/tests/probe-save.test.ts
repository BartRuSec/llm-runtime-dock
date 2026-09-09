import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResult, RuntimeAdapter } from '@llm-runtime-dock/core';
import type { AssignmentPrompt, RemovalPrompt } from '../src/prompt.js';
import { runCli } from '../src/index.js';

/**
 * `lrd probe --save` and the models it may not delete (spec §22, §27).
 *
 * Saving is a refresh, not a rewrite: an entry the probe rediscovers keeps
 * every option the user wrote on it, and one the probe did not find is removed
 * only when somebody said so — the prompt, or `--force`.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-probe-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `runProbe` reaches for three members only. Standing up the whole
 * `RuntimeAdapter` surface to exercise a CLI flag would say nothing extra.
 */
const stubAdapter = (ids: readonly string[]): RuntimeAdapter => {
  const result: ProbeResult = {
    status: 'running',
    url: 'http://127.0.0.1:8000',
    models: ids.map((id) => ({ id })),
  };
  return {
    id: 'stub',
    defaultProbeTarget: 'http://127.0.0.1:8000',
    // Cast or not, the CLI reads this at runtime: the `as unknown as` below
    // would happily compile without it and then fail on the first --interactive.
    probeQuestions: [],
    probe: async () => result,
    // Enough of the contract for `loadConfig` to succeed. Naming a *runtime* on
    // the command line needs the configuration to load; matching an adapter id
    // does not, which is why the older tests here got away without these.
    optionSpecs: {},
    reservedArgs: [],
    serverScopedOptionKeys: [],
    modelRelease: 'stop_server',
    validateOptions: (raw: unknown) => raw ?? {},
  } as unknown as RuntimeAdapter;
};

const configWith = (body: string, runtimes = '  stub: { adapter: stub, port: 8000 }\n'): string => {
  const path = join(dir, 'config.yaml');
  // An empty body would leave a bare `models:` key, which parses as null and
  // fails validation — so the file would not load and no runtime would be
  // declared, quietly turning a runtime-name test into an adapter-name one.
  writeFileSync(
    path,
    `server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n${runtimes}models:${
      body === '' ? ' {}\n' : `\n${body}`
    }`,
  );
  return path;
};

const harness = (removalPrompt?: RemovalPrompt, assignmentPrompt?: AssignmentPrompt) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (argv: string[]) =>
      runCli({
        argv,
        adapters: [stubAdapter(['fresh'])],
        agents: [],
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        removalPrompt,
        assignmentPrompt,
      }),
  };
};

/** Two runtimes on one adapter: the shape `keep_resident` forces on MTPLX. */
const TWO_RUNTIMES =
  '  mtplx: { adapter: stub, port: 8000 }\n  mtplx_resident: { adapter: stub, port: 8001 }\n';

describe('discovery: false', () => {
  const MANUAL =
    '  mtplx: { adapter: stub, port: 8000 }\n' +
    '  manual: { adapter: stub, port: 8001, discovery: false }\n';

  it('skips the runtime in a bare probe and says which one it skipped', async () => {
    const path = configWith('  fresh: { runtime: manual, backend_model: fresh }\n', MANUAL);
    const h = harness();

    const code = await h.run(['probe', '--config', path]);

    expect(code).toBe(0);
    expect(h.err.join('\n')).toContain('skipping manual (discovery: false)');
    // One line per probed runtime; `manual` must not be among them.
    expect(h.out.join('\n')).not.toMatch(/^manual\s+http/m);
  });

  it('still probes it when it is named, which is the only way out of the flag', async () => {
    const path = configWith('  fresh: { runtime: manual, backend_model: fresh }\n', MANUAL);
    const h = harness();

    const code = await h.run(['probe', 'manual', '--config', path]);

    expect(code).toBe(0);
    expect(h.err.join('\n')).not.toContain('skipping manual');
    expect(h.out.join('\n')).toMatch(/manual\s+http/);
  });

  it('never marks an excluded runtime\u2019s models stale, however long the backend is gone', async () => {
    const path = configWith('  gone: { runtime: manual, backend_model: gone }\n', MANUAL);
    const h = harness();

    const code = await h.run(['probe', '--save', '--config', path]);

    // The probe reports `fresh`, never `gone`. Because `manual` is never probed
    // it is not in `probedRuntimes`, so nothing on it can be proposed for
    // deletion — which is the whole point of calling it hand-managed.
    expect(code).toBe(0);
    expect(h.out.join('\n')).not.toContain('kept, not found');
    expect(readFileSync(path, 'utf8')).toContain('backend_model: gone');
  });

  it('does not probe the adapter default when every runtime of it is excluded', async () => {
    // The trap: dropping an excluded runtime from the "covered adapters" set
    // makes the uncovered-adapter fallback probe `defaultProbeTarget` and write
    // it as a brand-new runtime keyed by the adapter id.
    const path = configWith(
      '  fresh: { runtime: manual, backend_model: fresh }\n',
      '  manual: { adapter: stub, port: 8001, discovery: false }\n',
    );
    const h = harness();

    const code = await h.run(['probe', '--save', '--config', path]);

    expect(code).toBe(0);
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('stub:');
    expect(h.out.join('\n')).not.toMatch(/^stub\s+http/m);
  });

  it('reports nothing to probe when an adapter fan-out selects only excluded runtimes', async () => {
    const path = configWith(
      '  fresh: { runtime: manual, backend_model: fresh }\n',
      '  manual: { adapter: stub, port: 8001, discovery: false }\n',
    );
    const h = harness();

    const code = await h.run(['probe', 'stub', '--config', path]);

    // Falling through to the adapter branch here would probe :8000 instead.
    expect(code).toBe(0);
    expect(h.err.join('\n')).toContain('nothing to probe');
  });

  it('keeps the flag when the runtime is explicitly re-probed and saved', async () => {
    const path = configWith('  fresh: { runtime: manual, backend_model: fresh }\n', MANUAL);
    const h = harness();

    await h.run(['probe', 'manual', '--save', '--config', path]);

    expect(readFileSync(path, 'utf8')).toContain('discovery: false');
  });
});

describe('probe --save with two runtimes on one adapter', () => {
  it('leaves a model owned by a sibling runtime alone instead of refusing the save', async () => {
    const path = configWith('  fresh: { runtime: mtplx, backend_model: fresh }\n', TWO_RUNTIMES);
    const before = readFileSync(path, 'utf8');
    const h = harness();

    const code = await h.run(['probe', 'mtplx_resident', '--save', '--config', path]);

    // A DISCOVERY_NAME_CONFLICT here — `already configured for runtime
    // "mtplx"` — would block the whole save.
    expect(code).toBe(0);
    expect(h.err.join('\n')).not.toContain('DISCOVERY_NAME_CONFLICT');
    expect(h.out.join('\n')).toContain('left on mtplx: fresh');
    // The model entry is untouched; only the probed runtime's own block is
    // refreshed, which is what `--save` is for.
    expect(readFileSync(path, 'utf8')).toContain('fresh: { runtime: mtplx,');
    expect(before).toContain('fresh: { runtime: mtplx,');
  });

  it('asks which runtime owns a model neither of them has yet', async () => {
    const path = configWith('', TWO_RUNTIMES);
    const asked: string[] = [];
    const h = harness(undefined, async (question) => {
      asked.push(...question.ambiguous.map((entry) => entry.candidates.join('+')));
      return { fresh: 'mtplx_resident' };
    });

    const code = await h.run(['probe', '--save', '--config', path]);

    expect(code).toBe(0);
    expect(asked).toEqual(['mtplx+mtplx_resident']);
    expect(readFileSync(path, 'utf8')).toContain('runtime: mtplx_resident');
  });

  it('writes nothing for an ambiguous model when there is no terminal to ask on', async () => {
    const path = configWith('', TWO_RUNTIMES);
    const h = harness();

    const code = await h.run(['probe', '--save', '--config', path]);

    // Not written, not guessed, and said out loud — the run still succeeds so
    // everything unambiguous is saved.
    expect(code).toBe(0);
    expect(h.err.join('\n')).toContain('no terminal to ask on');
    expect(h.err.join('\n')).toContain('nothing says which should own it');
    expect(readFileSync(path, 'utf8')).not.toContain('fresh:');
  });
});

describe('probe --save', () => {
  it('rejects --force without --save rather than accepting a flag that did nothing', async () => {
    const h = harness();
    const code = await h.run(['probe', 'stub', '--force']);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('CONFIG_INVALID');
    expect(h.err.join('\n')).toContain('--force applies to --save');
  });

  it('keeps an entry the probe did not find when there is no terminal to ask on', async () => {
    const path = configWith('  idle: { runtime: stub, backend_model: idle }\n');
    // No prompt injected, and vitest is not a TTY: the run cannot ask.
    const h = harness();
    const code = await h.run(['probe', 'stub', '--save', '--config', path]);

    expect(code).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('backend_model: idle');
    expect(h.err.join('\n')).toContain('no terminal to ask on');
    expect(h.out.join('\n')).toContain('kept, not found by this probe: idle');
  });

  it('removes exactly what the prompt selected, and nothing else', async () => {
    const path = configWith(
      '  idle: { runtime: stub, backend_model: idle }\n' +
        '  also-idle: { runtime: stub, backend_model: also-idle }\n',
    );
    const asked: string[] = [];
    const h = harness(async (question) => {
      asked.push(...question.stale.map((entry) => entry.id));
      return ['idle'];
    });

    const code = await h.run(['probe', 'stub', '--save', '--config', path]);

    expect(code).toBe(0);
    expect(asked).toEqual(['idle', 'also-idle']);
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('backend_model: idle');
    // Offered and declined stays configured; only what was ticked goes.
    expect(written).toContain('backend_model: also-idle');
    expect(h.out.join('\n')).toContain('removed: idle');
  });

  it('removes every unfound entry with --force, and never asks', async () => {
    const path = configWith('  idle: { runtime: stub, backend_model: idle }\n');
    let asked = false;
    const h = harness(async () => {
      asked = true;
      return [];
    });

    const code = await h.run(['probe', 'stub', '--save', '--force', '--config', path]);

    expect(code).toBe(0);
    expect(asked).toBe(false);
    expect(readFileSync(path, 'utf8')).not.toContain('backend_model: idle');
  });

  it('asks nothing on a dry run, and leaves the file alone', async () => {
    const path = configWith('  idle: { runtime: stub, backend_model: idle }\n');
    const before = readFileSync(path, 'utf8');
    let asked = false;
    const h = harness(async () => {
      asked = true;
      return ['idle'];
    });

    const code = await h.run(['probe', 'stub', '--save', '--dry-run', '--config', path]);

    expect(code).toBe(0);
    expect(asked).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(h.err.join('\n')).toContain('a dry run removes nothing');
  });

  it('refuses to act on an answer about a file that changed while it was asked', async () => {
    const path = configWith('  idle: { runtime: stub, backend_model: idle }\n');
    const h = harness(async () => {
      // Standing in for a slow answer, during which the user edits the file.
      writeFileSync(
        path,
        'server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  stub: { adapter: stub, port: 8000 }\nmodels:\n  idle: { runtime: stub, backend_model: something-else }\n',
      );
      return ['idle'];
    });

    const code = await h.run(['probe', 'stub', '--save', '--config', path]);

    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('changed while the question was open');
    // The edit stands; the answer about the older file is discarded.
    expect(readFileSync(path, 'utf8')).toContain('backend_model: something-else');
  });

  it('refreshes a rediscovered entry without disturbing what was configured on it', async () => {
    const path = configWith(
      '  fresh:\n    runtime: stub\n    backend_model: fresh\n    args: [--ctx, "32768"]\n',
    );
    const h = harness();

    const code = await h.run(['probe', 'stub', '--save', '--config', path]);

    expect(code).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('--ctx');
    expect(h.out.join('\n')).toContain('refreshed, options kept: fresh');
  });
});
