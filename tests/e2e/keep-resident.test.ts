import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import { createOllamaAdapter } from '@llm-runtime-dock/adapter-ollama';
import { createOmlxAdapter } from '@llm-runtime-dock/adapter-omlx';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import type { DockService } from '@llm-runtime-dock/core';
import {
  FAKE_MTPLX,
  FAKE_OLLAMA,
  FAKE_OMLX,
  fakeLocation,
  fixtureCli,
  freePort,
  readAll,
} from '../helpers/env.js';
import { startFakeRuntime, type FakeRuntime } from '../helpers/fake-runtime.js';

/**
 * `keep_resident` against real adapters and real processes (spec §8).
 *
 * The core suite proves the scheduler's bookkeeping. What only an end-to-end
 * run can prove is the thing the flag exists for: that a server holding the kept
 * model is never stopped, and that a multi-model server is actually left holding
 * two models — the case an adapter's `enforceSingleResident` would otherwise
 * quietly undo.
 */

const logger = createLogger({ level: 'error', write: () => {} });

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

const residentModels = async (port: number): Promise<string[]> => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/models/status`);
  const body = (await response.json()) as { models: Array<{ id: string; loaded: boolean }> };
  return body.models
    .filter((entry) => entry.loaded)
    .map((entry) => entry.id)
    .sort();
};

/** Ollama's residency answer. `/api/ps` lists exactly what holds memory (§17). */
const residentOllamaModels = async (port: number): Promise<string[]> => {
  const response = await fetch(`http://127.0.0.1:${port}/api/ps`);
  const body = (await response.json()) as { models: Array<{ name: string }> };
  return body.models.map((entry) => entry.name).sort();
};

describe('keep_resident', () => {
  const servers: FakeRuntime[] = [];
  let service: DockService;
  let keptPort: number;
  let rotatingPort: number;

  afterEach(async () => {
    await service.shutdown();
    for (const server of servers.splice(0)) await server.stop();
  });

  describe('on a stop_server runtime of its own', () => {
    beforeEach(async () => {
      keptPort = await freePort();
      rotatingPort = await freePort();
      const registry = createAdapterRegistry([
        createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
      ]);
      // Two MTPLX servers: the small model owns :keptPort outright, which is the
      // only shape a single-model runtime can keep a model resident in.
      const config = parseConfig(
        registry,
        `
runtimes:
  mtplx-resident: { adapter: mtplx, port: ${keptPort} }
  mtplx: { adapter: mtplx, port: ${rotatingPort} }
models:
  small:
    runtime: mtplx-resident
    backend_model: qwen35-4b
    keep_resident: true
  coding-quality:
    runtime: mtplx
    backend_model: qwen38
  coding-balance:
    runtime: mtplx
    backend_model: qwen36
`,
        fakeLocation(),
      );
      service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });
    });

    it('never stops the kept model’s server, and rotates the others around it', async () => {
      expect(await post(service, 'small')).toBe(200);
      expect(await answering(keptPort)).toBe(true);

      // A switch to another entry must leave the kept server alone. For MTPLX
      // "release" is `mtplx stop --port`, so this is the whole feature: without
      // it the small model's process would be gone.
      expect(await post(service, 'coding-quality')).toBe(200);
      expect(await answering(keptPort)).toBe(true);
      expect(await answering(rotatingPort)).toBe(true);
      expect(service.status().kept.map((entry) => entry.modelId)).toEqual(['small']);
      expect(service.status().resident?.modelId).toBe('coding-quality');

      // Back to the small model: both servers are up, so this is a handover.
      expect(await post(service, 'small')).toBe(200);
      expect(service.status().serving).toBe('small');
      expect(await answering(rotatingPort)).toBe(true);
      expect(service.status().resident?.modelId).toBe('coding-quality');

      // Rotating → rotating still stops a server, and it is never the kept one.
      expect(await post(service, 'coding-balance')).toBe(200);
      expect(service.status().lastRelease?.modelId).toBe('coding-quality');
      expect(await answering(keptPort)).toBe(true);
    });

    it('releases the kept server on shutdown, where the flag stops applying', async () => {
      expect(await post(service, 'small')).toBe(200);
      expect(await post(service, 'coding-quality')).toBe(200);

      await service.shutdown();

      expect(await answering(keptPort)).toBe(false);
      expect(await answering(rotatingPort)).toBe(false);
    });
  });

  describe('on a shared unload_model runtime', () => {
    let omlxPort: number;

    beforeEach(async () => {
      omlxPort = await freePort();
      const registry = createAdapterRegistry([
        createOmlxAdapter({ ...fixtureCli(FAKE_OMLX), logger, startupTimeoutMs: 20_000 }),
      ]);
      const config = parseConfig(
        registry,
        `
runtimes:
  omlx: { adapter: omlx, port: ${omlxPort} }
models:
  omlx-small:
    runtime: omlx
    backend_model: llama-3b
    keep_resident: true
  omlx-coder:
    runtime: omlx
    backend_model: coder-35b
`,
        fakeLocation(),
      );
      service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });
    });

    it('leaves the kept model loaded while another model on the same server rotates', async () => {
      servers.push(
        await startFakeRuntime({
          port: omlxPort,
          multi: true,
          models: ['coder-35b', 'llama-3b'],
        }),
      );

      expect(await post(service, 'omlx-small')).toBe(200);
      expect(await residentModels(omlxPort)).toEqual(['llama-3b']);

      // `enforceSingleResident` would unload everything but its target. The
      // kept entry is passed as `keepLoaded`, so both stay in memory — the one
      // place where more than one model is resident on purpose.
      expect(await post(service, 'omlx-coder')).toBe(200);
      expect(await residentModels(omlxPort)).toEqual(['coder-35b', 'llama-3b']);

      // ...and a request for the kept model is a handover, not a reload.
      expect(await post(service, 'omlx-small')).toBe(200);
      expect(await residentModels(omlxPort)).toEqual(['coder-35b', 'llama-3b']);
      expect(service.status().serving).toBe('omlx-small');
    });
  });
  describe('on a shared Ollama runtime, where residency is compared by tag', () => {
    let ollamaPort: number;

    beforeEach(async () => {
      ollamaPort = await freePort();
      const registry = createAdapterRegistry([
        createOllamaAdapter({ ...fixtureCli(FAKE_OLLAMA), logger, startupTimeoutMs: 20_000 }),
      ]);
      // `max_loaded_models` is server-scoped, and Ollama would evict the kept
      // model to stay under a limit of 1 — the flag undone by the server itself,
      // which is why the option check refuses that combination at load time.
      const config = parseConfig(
        registry,
        `
runtimes:
  ollama: { adapter: ollama, port: ${ollamaPort}, options: { max_loaded_models: 2 } }
models:
  ollama-small:
    runtime: ollama
    backend_model: llama3.2
    keep_resident: true
  ollama-coder:
    runtime: ollama
    backend_model: qwen2.5-coder:7b
`,
        fakeLocation(),
      );
      service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });
    });

    it('leaves the kept model loaded, matching an untagged config id to a tagged one', async () => {
      servers.push(
        await startFakeRuntime({
          port: ollamaPort,
          multi: true,
          ollama: true,
          models: ['llama3.2', 'qwen2.5-coder:7b'],
        }),
      );

      expect(await post(service, 'ollama-small')).toBe(200);
      // The config says `llama3.2`; `/api/ps` answers `llama3.2:latest`. Every
      // residency comparison normalizes both sides, or `enforceSingleResident`
      // reads the model it just loaded as a stray.
      expect(await residentOllamaModels(ollamaPort)).toEqual(['llama3.2:latest']);

      expect(await post(service, 'ollama-coder')).toBe(200);
      expect(await residentOllamaModels(ollamaPort)).toEqual([
        'llama3.2:latest',
        'qwen2.5-coder:7b',
      ]);

      // ...and a request for the kept model is a handover, not a reload.
      expect(await post(service, 'ollama-small')).toBe(200);
      expect(await residentOllamaModels(ollamaPort)).toEqual([
        'llama3.2:latest',
        'qwen2.5-coder:7b',
      ]);
      expect(service.status().serving).toBe('ollama-small');
    });

    it('releases every kept model on shutdown, where the flag stops applying', async () => {
      servers.push(
        await startFakeRuntime({
          port: ollamaPort,
          multi: true,
          ollama: true,
          models: ['llama3.2', 'qwen2.5-coder:7b'],
        }),
      );
      expect(await post(service, 'ollama-small')).toBe(200);
      expect(await post(service, 'ollama-coder')).toBe(200);

      // The server is the user's and stays up; only the memory is given back.
      await service.shutdown();
      expect(await residentOllamaModels(ollamaPort)).toEqual([]);
    });
  });
});
