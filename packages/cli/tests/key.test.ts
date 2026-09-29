import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

/**
 * `lrd key generate` (spec §27, §28).
 *
 * A `--config <path>` that does not exist yet resolves its *write* target to
 * the real `~/.config/llm-runtime-dock/config.yaml` (`configWriteTarget`), so
 * every test here pre-creates a minimal file first — the documented way to
 * keep a config-writing command test inside its temp directory.
 */

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-key-'));
  configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, 'server: { host: 127.0.0.1, port: 8787 }\nmodels: {}\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const harness = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (argv: string[]) =>
      runCli({
        argv,
        adapters: [],
        agents: [],
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      }),
  };
};

describe('lrd key generate', () => {
  it('defaults to writing server.auth.api_key_file and a separate secret file', async () => {
    const h = harness();
    const code = await h.run(['key', 'generate', '--config', configPath]);
    expect(code).toBe(0);

    const configText = readFileSync(configPath, 'utf8');
    expect(configText).toContain('api_key_file');

    const printed = h.out.join('\n');
    expect(printed).toContain('lrd_');
    expect(printed).toContain('shown once');
  });

  it('--env writes server.auth.api_key_env and never touches disk for the secret', async () => {
    const h = harness();
    const code = await h.run(['key', 'generate', '--config', configPath, '--env']);
    expect(code).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toContain('api_key_env: LRD_API_KEY');
    expect(existsSync(join(dir, 'api_key'))).toBe(false);
  });

  it('--env NAME picks the variable name', async () => {
    const h = harness();
    await h.run(['key', 'generate', '--config', configPath, '--env', 'MY_VAR']);
    expect(readFileSync(configPath, 'utf8')).toContain('api_key_env: MY_VAR');
  });

  it('preserves the rest of the file', async () => {
    writeFileSync(configPath, '# a comment\nserver:\n  host: 0.0.0.0\n  port: 9999\nmodels: {}\n');
    const h = harness();
    await h.run(['key', 'generate', '--config', configPath, '--env']);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('# a comment');
    expect(text).toContain('host: 0.0.0.0');
    expect(text).toContain('port: 9999');
  });

  it('refuses to replace an already-configured key without --force', async () => {
    await harness().run(['key', 'generate', '--config', configPath]);
    const second = harness();
    const code = await second.run(['key', 'generate', '--config', configPath]);
    expect(code).toBe(1);
    expect(second.err.join('\n')).toContain('SERVER_KEY_ALREADY_CONFIGURED');
  });

  it('--force replaces it', async () => {
    await harness().run(['key', 'generate', '--config', configPath, '--env', 'FIRST']);
    const second = harness();
    const code = await second.run([
      'key',
      'generate',
      '--config',
      configPath,
      '--force',
      '--env',
      'SECOND',
    ]);
    expect(code).toBe(0);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('api_key_env: SECOND');
    expect(text).not.toContain('FIRST');
  });

  it('--dry-run writes nothing', async () => {
    const before = readFileSync(configPath, 'utf8');
    const h = harness();
    const code = await h.run(['key', 'generate', '--config', configPath, '--dry-run']);
    expect(code).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('--json reports the result machine-readably', async () => {
    const h = harness();
    await h.run(['key', 'generate', '--config', configPath, '--json']);
    const result = JSON.parse(h.out.join('\n')) as { key: string; mode: string; written: boolean };
    expect(result.mode).toBe('file');
    expect(result.key).toMatch(/^lrd_/);
    expect(result.written).toBe(true);
  });
});
