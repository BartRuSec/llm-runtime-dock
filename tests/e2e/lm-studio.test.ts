import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLmStudioAdapter } from '@llm-runtime-dock/adapter-lm-studio';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import type { DockService } from '@llm-runtime-dock/core';
import type { GatewayError } from '@llm-runtime-dock/core';
import { FAKE_LMS, fakeLocation, fixtureCli, freePort, readAll, tempDir } from '../helpers/env.js';

/**
 * LM Studio (spec §19): server lifecycle and model lifecycle are separate, and
 * releasing the resident slot must never take the shared server down.
 */

const logger = createLogger({ level: 'error', write: () => {} });

describe('lm-studio adapter', () => {
  let dir: ReturnType<typeof tempDir>;
  let statePath: string;
  let argvPath: string;
  let service: DockService;
  let port: number;

  beforeEach(async () => {
    dir = tempDir();
    statePath = join(dir.path, 'lms-state.json');
    argvPath = join(dir.path, 'argv.log');
    port = await freePort();

    process.env.FAKE_LMS_STATE = statePath;
    process.env.FAKE_ARGV_FILE = argvPath;

    const registry = createAdapterRegistry([
      createLmStudioAdapter({ ...fixtureCli(FAKE_LMS), logger, startupTimeoutMs: 20_000 }),
    ]);
    const config = parseConfig(
      registry,
      `
runtimes:
  lm-studio: { adapter: lm-studio, port: ${port} }
models:
  local-a:
    runtime: lm-studio
    backend_model: qwen2.5-coder-32b
    options: { context_length: 131072, gpu: max }
  local-b:
    runtime: lm-studio
    backend_model: llama-3b
`,
      fakeLocation(),
    );
    service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
    // Take the fixture's daemon down so the port is free for the next test.
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { port?: number };
      if (state.port) await fetch(`http://127.0.0.1:${state.port}/__shutdown`).catch(() => {});
    } catch {
      // no server was started
    }
    delete process.env.FAKE_LMS_STATE;
    delete process.env.FAKE_ARGV_FILE;
    dir.cleanup();
  });

  const post = async (model: string): Promise<number> => {
    const controller = new AbortController();
    const response = await service.proxy({
      path: 'chat/completions',
      body: JSON.stringify({ model, messages: [] }),
      headers: {},
      signal: controller.signal,
      requestId: `req-${model}`,
    });
    await readAll(response.stream);
    return response.status;
  };

  const argvLines = (): string[][] => {
    if (!existsSync(argvPath)) return [];
    return readFileSync(argvPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  };

  it('starts the server once, then loads with a gateway-assigned identifier', async () => {
    expect(await post('local-a')).toBe(200);

    const calls = argvLines();
    expect(calls.some((call) => call[0] === 'server' && call[1] === 'start')).toBe(true);

    const load = calls.find((call) => call[0] === 'load');
    expect(load).toBeDefined();
    expect(load?.[1]).toBe('qwen2.5-coder-32b');
    // The identifier is the entry key, which is what identity verification and
    // the upstream request both use.
    expect(load?.[load.indexOf('--identifier') + 1]).toBe('local-a');
    expect(load).toContain('--context-length');
    expect(load).toContain('131072');
    expect(load).toContain('--gpu');
    expect(load).toContain('max');
    expect(load).toContain('--yes');

    expect(service.status().resident?.modelRelease).toBe('unload_model');
  });

  it('releases the model with unload and never stops the shared server', async () => {
    expect(await post('local-a')).toBe(200);
    expect(await post('local-b')).toBe(200);

    const calls = argvLines();
    expect(calls.some((call) => call[0] === 'unload' && call[1] === 'local-a')).toBe(true);
    // `lms server stop` must appear nowhere in a switch.
    expect(calls.some((call) => call[0] === 'server' && call[1] === 'stop')).toBe(false);

    // The server survived the switch: it is still answering.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(service.status().lastRelease).toEqual({ modelId: 'local-a', via: 'unload_model' });
  });

  it('starts only one server across a switch', async () => {
    await post('local-a');
    await post('local-b');
    const starts = argvLines().filter((call) => call[0] === 'server' && call[1] === 'start');
    expect(starts).toHaveLength(1);
  });

  it('spares a kept model when enforcing one resident on the shared server', async () => {
    // `enforceSingleResident` unloads every identifier that is not the target,
    // which would silently undo `keep_resident` for two entries sharing one
    // LM Studio server (§8). The scheduler passes the kept identifier through
    // as `keepLoaded`, and it must survive the switch.
    const registry = createAdapterRegistry([
      createLmStudioAdapter({ ...fixtureCli(FAKE_LMS), logger, startupTimeoutMs: 20_000 }),
    ]);
    const config = parseConfig(
      registry,
      `
runtimes:
  lm-studio: { adapter: lm-studio, port: ${port} }
models:
  kept:
    runtime: lm-studio
    backend_model: nomic-embed
    keep_resident: true
  rotating:
    runtime: lm-studio
    backend_model: qwen2.5-coder-32b
`,
      fakeLocation(),
    );
    await service.shutdown().catch(() => {});
    service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });

    expect(await post('kept')).toBe(200);
    expect(await post('rotating')).toBe(200);

    const calls = argvLines();
    expect(calls.some((call) => call[0] === 'unload' && call[1] === 'kept')).toBe(false);
    expect(calls.filter((call) => call[0] === 'load').map((call) => call[1])).toEqual([
      'nomic-embed',
      'qwen2.5-coder-32b',
    ]);
    expect(service.status().kept.map((entry) => entry.modelId)).toEqual(['kept']);
    expect(service.status().resident?.modelId).toBe('rotating');
  });

  it('refuses to stop the shared server, representing the limitation cleanly', async () => {
    await post('local-a');
    const adapter = service.registry.get('lm-studio');
    const instance = service.config.models.get('local-a')!;

    let thrown: unknown;
    try {
      await adapter.stop(instance);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as GatewayError).code).toBe('RUNTIME_STOP_FAILED');
    expect((thrown as GatewayError).message).toContain('lms unload');
  });

  it('fails with an actionable error when a server answers on a different port', async () => {
    // Start the fixture's server on its own port, then ask for an entry
    // configured for a different one.
    await post('local-a');
    const otherPort = await freePort();

    const registry = createAdapterRegistry([
      createLmStudioAdapter({ ...fixtureCli(FAKE_LMS), logger, startupTimeoutMs: 10_000 }),
    ]);
    const mismatched = createDockService({
      config: parseConfig(
        registry,
        `runtimes:\n  lm-studio: { adapter: lm-studio, port: ${otherPort} }\nmodels:\n  x: { runtime: lm-studio, backend_model: m }`,
        fakeLocation(),
      ),
      registry,
      logger,
      readyTimeoutMs: 10_000,
    });

    let thrown: unknown;
    try {
      const controller = new AbortController();
      await mismatched.proxy({
        path: 'chat/completions',
        body: JSON.stringify({ model: 'x', messages: [] }),
        headers: {},
        signal: controller.signal,
        requestId: 'mismatch',
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as GatewayError;
    expect(error.code).toBe('RUNTIME_START_FAILED');
    // The message names both ports so the user can fix it.
    expect(error.message).toContain(String(port));
    expect(error.message).toContain(String(otherPort));
    await mismatched.shutdown().catch(() => {});
  });
});
