import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import type { DockService } from '@llm-runtime-dock/core';
import { FAKE_MTPLX, fakeLocation, fixtureCli, freePort, tempDir } from '../helpers/env.js';

/**
 * What actually reaches `mtplx serve` (spec §18).
 *
 * The adapter's own tests assert what `serveArgs` returns; this asserts that the
 * argv arrived on a real command line, which is the part a unit test cannot see
 * and the part that was missing when the dock could not steer tool rendering at
 * all.
 */

const logger = createLogger({ level: 'error', write: () => {} });

describe('mtplx launch argv', () => {
  let dir: ReturnType<typeof tempDir>;
  let argvPath: string;
  let service: DockService;
  let port: number;

  const configure = async (options: string): Promise<void> => {
    const registry = createAdapterRegistry([
      createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
    ]);
    const config = parseConfig(
      registry,
      `
runtimes:
  mtplx: { adapter: mtplx, port: ${port} }
models:
  quality:
    runtime: mtplx
    backend_model: fake-model
${options}
`,
      fakeLocation(),
    );
    service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });
  };

  const start = async (): Promise<string[]> => {
    await service.switchTo('quality');
    const lines = readFileSync(argvPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);
    return lines.find((argv) => argv[0] === 'serve')!;
  };

  beforeEach(async () => {
    dir = tempDir();
    argvPath = join(dir.path, 'argv.log');
    port = await freePort();
    process.env.FAKE_ARGV_FILE = argvPath;
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
    delete process.env.FAKE_ARGV_FILE;
    dir.cleanup();
  });

  it('applies the launch defaults when the entry sets nothing', async () => {
    await configure('');
    // One default, and it is model-independent: MTPLX otherwise appends a
    // visible TPS footer to the text of every response it returns.
    expect(await start()).toEqual([
      'serve',
      '--model',
      'fake-model',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-stats-footer',
    ]);
  });

  it('puts the tool-calling flags on the command line, which is what they exist for', async () => {
    await configure(
      '    options: { tool_prompt_mode: native, chat_template_profile: tokenizer, agent_rewrites: off, preserve_thinking: scoped }',
    );
    const argv = await start();
    // These are model-dependent, so the dock never guesses them — but it has to
    // be able to carry them.
    expect(argv).toContain('--tool-prompt-mode');
    expect(argv[argv.indexOf('--tool-prompt-mode') + 1]).toBe('native');
    expect(argv[argv.indexOf('--chat-template-profile') + 1]).toBe('tokenizer');
    expect(argv[argv.indexOf('--agent-rewrites') + 1]).toBe('off');
    expect(argv[argv.indexOf('--preserve-thinking') + 1]).toBe('scoped');
  });

  it('lets an entry drop the dock defaults and take MTPLX bare', async () => {
    await configure('    options: { defaults: false }');
    expect(await start()).toEqual([
      'serve',
      '--model',
      'fake-model',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ]);
  });
});
