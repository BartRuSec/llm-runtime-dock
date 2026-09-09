import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeAdapter } from '@llm-runtime-dock/core';
import { runCli } from '../src/index.js';

/**
 * How the read-only commands report `disabled` (spec §12, §27).
 *
 * A disabled entry is still configuration the user wrote, so `models` and
 * `doctor` keep showing it — it is `/v1/models` and `apply` that leave it out.
 * What matters here is that "not served" is reported as its own fact rather
 * than smuggled into the lifecycle `STATE` column, and that a runtime holding
 * only disabled entries does not fall out of the report altogether.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-models-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `runModels` reads an adapter for its id alone; config loading needs the rest. */
const stubAdapter = (): RuntimeAdapter =>
  ({
    id: 'stub',
    modelRelease: 'stop_server',
    optionSpecs: {},
    reservedArgs: [],
    serverScopedOptionKeys: [],
    defaultProbeTarget: 'http://127.0.0.1:8000',
    probeQuestions: [],
    validateOptions: (options: unknown) => options,
  }) as unknown as RuntimeAdapter;

const configWith = (body: string): string => {
  const path = join(dir, 'config.yaml');
  writeFileSync(
    path,
    `server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  stub: { adapter: stub, port: 8000 }\nmodels:\n${body}`,
  );
  return path;
};

const harness = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (argv: string[]) =>
      runCli({
        argv,
        adapters: [stubAdapter()],
        agents: [],
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      }),
  };
};

const path = () =>
  configWith(
    '  served: { runtime: stub, backend_model: Model-A }\n' +
      '  embeddings: { runtime: stub, backend_model: Embed-M, disabled: true }\n',
  );

describe('lrd models', () => {
  it('carries `disabled` in the JSON rows', async () => {
    const h = harness();
    const code = await h.run(['models', '--json', '--config', path()]);

    expect(code).toBe(0);
    const rows = JSON.parse(h.out.join('\n')) as Array<{ id: string; disabled: boolean }>;
    expect(rows.map((row) => ({ id: row.id, disabled: row.disabled }))).toEqual([
      { id: 'served', disabled: false },
      { id: 'embeddings', disabled: true },
    ]);
  });

  it('reports it in its own column, leaving STATE to the lifecycle', async () => {
    const h = harness();
    const code = await h.run(['models', '--no-color', '--config', path()]);

    expect(code).toBe(0);
    const lines = h.out.filter((line) => line.trim() !== '');
    expect(lines[0]).toContain('STATE');
    expect(lines[0]).toContain('DISABLED');
    // Both entries are listed, and both report the lifecycle state they have.
    expect(lines[1]).toMatch(/^served\s.*\sstopped\s+-$/);
    expect(lines[2]).toMatch(/^embeddings\s.*\sstopped\s+yes$/);

    // The cell starts under its own header, which is the point of `columns`.
    const at = lines[0]!.indexOf('DISABLED');
    expect(lines[1]!.slice(at)).toBe('-');
    expect(lines[2]!.slice(at)).toBe('yes');
  });
});

describe('lrd doctor', () => {
  it('reports a disabled entry, and says nothing will start a runtime that holds only those', async () => {
    const h = harness();
    const config = configWith(
      '  embeddings: { runtime: stub, backend_model: Embed-M, disabled: true }\n',
    );
    const code = await h.run(['doctor', '--no-color', '--config', config]);

    const report = h.out.join('\n');
    expect(report).toContain('models.embeddings: disabled');
    // Every entry on the runtime is disabled, so the endpoint and executable
    // checks below all skip it. Without this the runtime vanishes silently.
    expect(report).toContain('every model on it is disabled');
    // A deliberate configuration, so nothing here is an error.
    expect(code).toBe(0);
  });
});
