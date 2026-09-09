import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import { createOmlxAdapter } from '@llm-runtime-dock/adapter-omlx';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import type { DockService } from '@llm-runtime-dock/core';
import type { GatewayError } from '@llm-runtime-dock/core';
import {
  FAKE_MTPLX,
  FAKE_OMLX,
  fakeLocation,
  fixtureCli,
  freePort,
  readAll,
} from '../helpers/env.js';
import { startFakeRuntime, type FakeRuntime } from '../helpers/fake-runtime.js';

/**
 * The resident slot (spec §8) and cross-adapter switching (§24).
 *
 * A shared server is not a shared slot: two oMLX entries on one server still
 * transition through a full unload/load, because both cannot be resident.
 */

const logger = createLogger({ level: 'error', write: () => {} });

interface Harness {
  service: DockService;
  omlxPort: number;
  mtplxPort: number;
}

const residentModels = async (port: number): Promise<string[]> => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/models/status`);
  const body = (await response.json()) as { models: Array<{ id: string; loaded: boolean }> };
  return body.models.filter((entry) => entry.loaded).map((entry) => entry.id);
};

/** The stop is a request the fixture answers before exiting, so give it a moment. */
const expectPortDead = async (port: number): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server on :${port} is still answering; it should have been stopped`);
};

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

describe('resident slot', () => {
  const servers: FakeRuntime[] = [];
  let harness: Harness;

  beforeEach(async () => {
    const omlxPort = await freePort();
    const mtplxPort = await freePort();
    const registry = createAdapterRegistry([
      createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
      createOmlxAdapter({ ...fixtureCli(FAKE_OMLX), logger, startupTimeoutMs: 20_000 }),
    ]);
    const config = parseConfig(
      registry,
      `
runtimes:
  omlx: { adapter: omlx, port: ${omlxPort} }
  mtplx: { adapter: mtplx, port: ${mtplxPort} }
models:
  omlx-coder:
    runtime: omlx
    backend_model: coder-35b
  omlx-small:
    runtime: omlx
    backend_model: llama-3b
  coding-quality:
    runtime: mtplx
    backend_model: qwen38
`,
      fakeLocation(),
    );
    harness = {
      service: createDockService({ config, registry, logger, readyTimeoutMs: 20_000 }),
      omlxPort,
      mtplxPort,
    };
  });

  afterEach(async () => {
    await harness.service.shutdown();
    for (const server of servers.splice(0)) await server.stop();
  });

  it('keeps exactly one model resident across oMLX → MTPLX → oMLX', async () => {
    // An oMLX server is already up; the gateway must attach, not spawn a second.
    servers.push(
      await startFakeRuntime({
        port: harness.omlxPort,
        multi: true,
        models: ['coder-35b', 'llama-3b'],
      }),
    );

    expect(await post(harness.service, 'omlx-coder')).toBe(200);
    expect(await residentModels(harness.omlxPort)).toEqual(['coder-35b']);
    expect(harness.service.status().resident?.ownership).toBe('attached');

    // Cross-adapter: releasing an oMLX model to start MTPLX.
    expect(await post(harness.service, 'coding-quality')).toBe(200);
    expect(await residentModels(harness.omlxPort)).toEqual([]);
    expect(harness.service.status().resident?.modelId).toBe('coding-quality');
    expect(harness.service.status().lastRelease?.via).toBe('unload_model');

    // ...and back again. The oMLX server was never stopped, only unloaded.
    expect(await post(harness.service, 'omlx-small')).toBe(200);
    expect(await residentModels(harness.omlxPort)).toEqual(['llama-3b']);
    expect(harness.service.status().lastRelease?.via).toBe('stop_server');
  });

  it('stops a stop_server runtime it only attached to, to free the slot', async () => {
    // A foreign MTPLX server is already serving exactly what this entry wants,
    // so the gateway attaches rather than spawning one (§8).
    servers.push(await startFakeRuntime({ port: harness.mtplxPort, model: 'qwen38' }));
    servers.push(
      await startFakeRuntime({ port: harness.omlxPort, multi: true, models: ['coder-35b'] }),
    );

    expect(await post(harness.service, 'coding-quality')).toBe(200);
    expect(harness.service.status().resident?.ownership).toBe('attached');

    // Switching away frees the slot with the occupant's own mechanism, and for a
    // single-model runtime there is no lever but stopping the server — even one
    // the gateway did not start. The one-resident invariant outranks leaving a
    // foreign single-model server alone (§8).
    expect(await post(harness.service, 'omlx-coder')).toBe(200);
    expect(harness.service.status().lastRelease).toEqual({
      modelId: 'coding-quality',
      via: 'stop_server',
    });
    await expectPortDead(harness.mtplxPort);
    expect(await residentModels(harness.omlxPort)).toEqual(['coder-35b']);
  });

  it('treats a shared server as a shared server, not a shared slot', async () => {
    servers.push(
      await startFakeRuntime({
        port: harness.omlxPort,
        multi: true,
        models: ['coder-35b', 'llama-3b'],
      }),
    );

    await post(harness.service, 'omlx-coder');
    expect(await residentModels(harness.omlxPort)).toEqual(['coder-35b']);

    // Same server, already up and healthy. That changes nothing: the transition
    // is still a full release then acquire.
    await post(harness.service, 'omlx-small');
    expect(await residentModels(harness.omlxPort)).toEqual(['llama-3b']);
    expect(harness.service.status().lastRelease).toEqual({
      modelId: 'omlx-coder',
      via: 'unload_model',
    });
  });

  it('corrects a runtime that auto-loaded a second model before reporting ready', async () => {
    // oMLX loads models by itself with LRU eviction; the fixture mimics that by
    // making every load pull in a second model.
    servers.push(
      await startFakeRuntime({
        port: harness.omlxPort,
        multi: true,
        models: ['coder-35b', 'llama-3b'],
        autoload: 'llama-3b',
      }),
    );

    expect(await post(harness.service, 'omlx-coder')).toBe(200);
    expect(await residentModels(harness.omlxPort)).toEqual(['coder-35b']);
  });

  it('fails the switch rather than doubling residency when a model is pinned', async () => {
    servers.push(
      await startFakeRuntime({
        port: harness.omlxPort,
        multi: true,
        models: ['coder-35b', 'llama-3b'],
        loaded: ['llama-3b'],
        pinned: ['llama-3b'],
      }),
    );

    let thrown: unknown;
    try {
      await post(harness.service, 'omlx-coder');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as GatewayError | undefined)?.code).toBe('RUNTIME_MODEL_PINNED');
    // Never proceed leaving two models resident.
    expect(harness.service.status().resident).toBeNull();
  });

  it('spawns when nothing answers and attaches when something does', async () => {
    // A spawned oMLX discovers models under its model directory; the fixture
    // takes that list from the environment it inherits.
    const previous = process.env.FAKE_MODELS;
    process.env.FAKE_MODELS = 'coder-35b,llama-3b';
    try {
      // Nothing running: the gateway spawns and owns the server.
      expect(await post(harness.service, 'omlx-coder')).toBe(200);
      expect(harness.service.status().resident?.ownership).toBe('spawned');
    } finally {
      if (previous === undefined) delete process.env.FAKE_MODELS;
      else process.env.FAKE_MODELS = previous;
    }
    await harness.service.shutdown();

    // Now a server is already answering: attach instead.
    servers.push(
      await startFakeRuntime({ port: harness.omlxPort, multi: true, models: ['coder-35b'] }),
    );
    const second = createDockService({
      config: harness.service.config,
      registry: harness.service.registry,
      logger,
      readyTimeoutMs: 20_000,
    });
    expect(await post(second, 'omlx-coder')).toBe(200);
    expect(second.status().resident?.ownership).toBe('attached');
    await second.shutdown();
  });
});
