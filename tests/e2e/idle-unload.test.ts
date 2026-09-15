import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLmStudioAdapter } from '@llm-runtime-dock/adapter-lm-studio';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import type { DockService } from '@llm-runtime-dock/core';
import {
  FAKE_LMS,
  FAKE_MTPLX,
  fakeLocation,
  fixtureCli,
  freePort,
  readAll,
  tempDir,
  waitFor,
} from '../helpers/env.js';

/**
 * Idle unload against real adapters and real processes (spec §29).
 *
 * The core suite proves the scheduler's bookkeeping. What only an end-to-end run
 * can prove is that memory was actually given back: that a single-model server
 * the gateway spawned is gone from its port, and that unloading from a shared
 * server leaves the server itself answering.
 */

const logger = createLogger({ level: 'error', write: () => {} });

const IDLE_MS = 400;

const post = async (service: DockService, model: string): Promise<number> => {
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

const answering = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    return true;
  } catch {
    return false;
  }
};

describe('idle unload', () => {
  describe('on a stop_server runtime', () => {
    let service: DockService;
    let rotatingPort: number;
    let keptPort: number;

    beforeEach(async () => {
      rotatingPort = await freePort();
      keptPort = await freePort();
      const registry = createAdapterRegistry([
        createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
      ]);
      const config = parseConfig(
        registry,
        `
server:
  idle_unload: ${IDLE_MS}ms
runtimes:
  mtplx: { adapter: mtplx, port: ${rotatingPort} }
  mtplx-resident: { adapter: mtplx, port: ${keptPort} }
models:
  coding-quality:
    runtime: mtplx
    backend_model: qwen38
  small:
    runtime: mtplx-resident
    backend_model: qwen35-4b
    keep_resident: true
`,
        fakeLocation(),
      );
      // The config file is the source here, so this also covers the duration
      // spelling reaching the scheduler rather than only the flag.
      service = createDockService({
        config,
        registry,
        logger,
        readyTimeoutMs: 20_000,
        idleUnloadMs: config.server.idleUnloadMs,
      });
    });

    afterEach(async () => {
      await service.shutdown().catch(() => {});
    });

    it('stops the server it spawned, and says why', async () => {
      expect(await post(service, 'coding-quality')).toBe(200);
      expect(await answering(rotatingPort)).toBe(true);

      await waitFor(() => service.status().resident === null, { timeoutMs: 10_000 });
      // Not just the bookkeeping: the process is gone from its port.
      await waitFor(async () => !(await answering(rotatingPort)), { timeoutMs: 10_000 });
      const status = service.status();
      expect(status.lastRelease).toEqual({
        modelId: 'coding-quality',
        via: 'stop_server',
        reason: 'idle',
      });
    });

    it('loads it again on the next request, as if nothing had happened', async () => {
      expect(await post(service, 'coding-quality')).toBe(200);
      await waitFor(() => service.status().resident === null, { timeoutMs: 10_000 });
      await waitFor(async () => !(await answering(rotatingPort)), { timeoutMs: 10_000 });

      expect(await post(service, 'coding-quality')).toBe(200);
      expect(service.status().resident?.modelId).toBe('coding-quality');
    });

    it('leaves a kept entry loaded, and still releases it on shutdown', async () => {
      expect(await post(service, 'small')).toBe(200);
      expect(await post(service, 'coding-quality')).toBe(200);

      // The occupant goes; the kept model's server is untouched. Its lifetime
      // is the gateway's, and an idle window is not the gateway stopping (§8).
      await waitFor(() => service.status().resident === null, { timeoutMs: 10_000 });
      await waitFor(async () => !(await answering(rotatingPort)), { timeoutMs: 10_000 });
      expect(await answering(keptPort)).toBe(true);
      expect(service.status().kept.map((entry) => entry.modelId)).toEqual(['small']);

      await service.shutdown();
      await waitFor(async () => !(await answering(keptPort)), { timeoutMs: 10_000 });
    });
  });

  describe('on an unload_model runtime', () => {
    let dir: ReturnType<typeof tempDir>;
    let statePath: string;
    let service: DockService;
    let port: number;

    beforeEach(async () => {
      dir = tempDir();
      statePath = join(dir.path, 'lms-state.json');
      port = await freePort();
      process.env.FAKE_LMS_STATE = statePath;

      const registry = createAdapterRegistry([
        createLmStudioAdapter({ ...fixtureCli(FAKE_LMS), logger, startupTimeoutMs: 20_000 }),
      ]);
      const config = parseConfig(
        registry,
        `
runtimes:
  lm-studio: { adapter: lm-studio, port: ${port} }
models:
  local-a: { runtime: lm-studio, backend_model: qwen2.5-coder-32b }
`,
        fakeLocation(),
      );
      service = createDockService({
        config,
        registry,
        logger,
        readyTimeoutMs: 20_000,
        idleUnloadMs: IDLE_MS,
      });
    });

    afterEach(async () => {
      await service.shutdown().catch(() => {});
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as { port?: number };
        if (state.port) await fetch(`http://127.0.0.1:${state.port}/__shutdown`).catch(() => {});
      } catch {
        // no server was started
      }
      delete process.env.FAKE_LMS_STATE;
      dir.cleanup();
    });

    it('unloads the model and leaves the shared server up', async () => {
      expect(await post(service, 'local-a')).toBe(200);

      await waitFor(() => service.status().resident === null, { timeoutMs: 10_000 });
      expect(service.status().lastRelease).toEqual({
        modelId: 'local-a',
        via: 'unload_model',
        reason: 'idle',
      });
      // The server is not the gateway's to stop, and the idle timer never
      // pretends otherwise.
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    });
  });
});
