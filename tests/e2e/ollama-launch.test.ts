import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOllamaAdapter } from '@llm-runtime-dock/adapter-ollama';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import type { DockService } from '@llm-runtime-dock/core';
import { FAKE_OLLAMA, fakeLocation, fixtureCli, freePort } from '../helpers/env.js';

const logger = createLogger({ level: 'error', write: () => {} });

describe('ollama launch', () => {
  let service: DockService;
  let port: number;
  beforeEach(async () => {
    port = await freePort();
  });
  afterEach(async () => {
    await service?.shutdown().catch(() => {});
  });

  it('spawns through OLLAMA_HOST and loads the model', async () => {
    const registry = createAdapterRegistry([
      createOllamaAdapter({ ...fixtureCli(FAKE_OLLAMA), logger, startupTimeoutMs: 20_000 }),
    ]);
    const config = parseConfig(
      registry,
      `runtimes:\n  ollama: { adapter: ollama, port: ${port} }\nmodels:\n  llama: { runtime: ollama, backend_model: llama3.2 }`,
      fakeLocation(),
    );
    service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });
    await service.switchTo('llama');
    const check = await fetch(`http://127.0.0.1:${port}/api/ps`).then(
      (response) => response.json() as Promise<{ models: Array<{ name: string }> }>,
    );
    expect(check.models.map((model) => model.name)).toEqual(['llama3.2:latest']);
  });
});
