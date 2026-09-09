import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import type { DockService } from '@llm-runtime-dock/core';
import { FAKE_MTPLX, fakeLocation, fixtureCli, freePort, readAll } from '../helpers/env.js';
import { startFakeRuntime } from '../helpers/fake-runtime.js';

/**
 * The critical integration scenario from spec §31: cold start, readiness, model
 * verification, warm reuse, streaming drain, and a switch that waits for the
 * stream to finish.
 */

const logger = createLogger({ level: 'error', write: () => {} });

const buildService = (portA: number, portB: number): DockService => {
  const registry = createAdapterRegistry([
    createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
  ]);
  const config = parseConfig(
    registry,
    `
server: { host: 127.0.0.1, port: 8787 }
runtimes:
  mtplx: { adapter: mtplx, port: ${portA} }
  mtplx2: { adapter: mtplx, port: ${portB} }
models:
  coding-quality:
    runtime: mtplx
    backend_model: qwen38
    options: { reasoning: "on", context_window: 131072, max_tokens: 32768 }
  coding-fast:
    runtime: mtplx2
    backend_model: qwen36
    options: { reasoning: "off", depth: 3 }
`,
    fakeLocation(),
  );
  return createDockService({
    config,
    registry,
    logger,
    readyTimeoutMs: 20_000,
    drainTimeoutMs: 20_000,
  });
};

const post = async (
  service: DockService,
  model: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; text: string }> => {
  const controller = new AbortController();
  const response = await service.proxy({
    path: 'chat/completions',
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
    headers: {},
    signal: controller.signal,
    requestId: `req-${model}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { status: response.status, text: response.text ?? (await readAll(response.stream)) };
};

describe('runtime switching', () => {
  let service: DockService;
  let portA: number;
  let portB: number;

  beforeEach(async () => {
    portA = await freePort();
    portB = await freePort();
    service = buildService(portA, portB);
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it('cold starts, verifies identity, proxies, and reuses a warm runtime', async () => {
    expect(service.status().resident).toBeNull();

    const first = await post(service, 'coding-quality');
    expect(first.status).toBe(200);
    // The client-facing logical id is resolved to the backend model upstream.
    expect(JSON.parse(first.text).received_model).toBe('qwen38');

    const status = service.status();
    expect(status.resident?.modelId).toBe('coding-quality');
    expect(status.resident?.state).toBe('ready');
    expect(status.resident?.ownership).toBe('spawned');
    expect(status.resident?.modelRelease).toBe('stop_server');

    const startedAt = status.resident?.since;
    const second = await post(service, 'coding-quality');
    expect(second.status).toBe(200);
    // A warm request must not restart anything.
    expect(service.status().resident?.since).toBe(startedAt);
  });

  it('serves two concurrent requests for the same cold model with one start', async () => {
    const [a, b] = await Promise.all([
      post(service, 'coding-quality'),
      post(service, 'coding-quality'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(service.status().resident?.modelId).toBe('coding-quality');
  });

  it('queues a different model behind an active stream, then switches', async () => {
    const controller = new AbortController();
    const stream = await service.proxy({
      path: 'chat/completions',
      body: JSON.stringify({ model: 'coding-quality', messages: [], stream: true }),
      headers: {},
      signal: controller.signal,
      requestId: 'stream-1',
    });
    expect(stream.status).toBe(200);
    expect(service.status().resident?.modelId).toBe('coding-quality');

    // Ask for the other entry while the stream is still open.
    const queued = post(service, 'coding-fast');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.status().resident?.modelId).toBe('coding-quality');
    expect(service.status().queueDepth).toBe(1);

    // Draining the stream is what unblocks the switch.
    const streamed = await readAll(stream.stream);
    expect(streamed).toContain('chunk0');
    expect(streamed).toContain('[DONE]');

    const result = await queued;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text).received_model).toBe('qwen36');

    const status = service.status();
    expect(status.resident?.modelId).toBe('coding-fast');
    expect(status.lastRelease).toEqual({ modelId: 'coding-quality', via: 'stop_server' });

    // A second request for the now-resident entry must not restart it.
    const since = status.resident?.since;
    await post(service, 'coding-fast');
    expect(service.status().resident?.since).toBe(since);
  });

  it('switches through the scheduler on an explicit switch', async () => {
    await service.switchTo('coding-fast');
    expect(service.status().resident?.modelId).toBe('coding-fast');

    // Two simultaneous switches to the same entry join one transition.
    await Promise.all([service.switchTo('coding-quality'), service.switchTo('coding-quality')]);
    expect(service.status().resident?.modelId).toBe('coding-quality');
    expect(service.status().resident?.state).toBe('ready');
  });
});

describe('served model identity', () => {
  let service: DockService;

  afterEach(async () => {
    await service?.shutdown().catch(() => {});
  });

  it('proxies under the id the server reports, not the configured reference', async () => {
    // MTPLX derives its served id from the loaded artifact, so `--model
    // <repo-id>` is served under a different name. The gateway learns that name
    // from /v1/models and rewrites the request body to it.
    const port = await freePort();
    const registry = createAdapterRegistry([
      createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
    ]);
    const config = parseConfig(
      registry,
      `runtimes:\n  mtplx: { adapter: mtplx, port: ${port} }\nmodels:\n  quality: { runtime: mtplx, backend_model: Vendor/Some-Model-27B }`,
      fakeLocation(),
    );
    service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });

    const response = await service.proxy({
      path: 'chat/completions',
      body: JSON.stringify({ model: 'quality', messages: [] }),
      headers: {},
      signal: new AbortController().signal,
      requestId: 'served-id',
    });
    const body = JSON.parse(response.text ?? (await readAll(response.stream))) as {
      received_model: string;
    };
    // The fixture serves whatever --model named, so this also proves the
    // learned id is used rather than the entry key.
    expect(body.received_model).toBe('Vendor/Some-Model-27B');
    expect(service.registry.get('mtplx').servedModelId(config.models.get('quality')!)).toBe(
      'Vendor/Some-Model-27B',
    );
  });

  it('replaces a server that is up but serving nothing', async () => {
    // The state that started this: the port answers, but /v1/models is empty.
    // That must not read as ready — the server is holding the slot without a
    // model, so it is released and restarted with the one this entry wants.
    const port = await freePort();
    const server = await startFakeRuntime({ port, multi: true, models: [] });
    try {
      const registry = createAdapterRegistry([
        createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
      ]);
      const config = parseConfig(
        registry,
        `runtimes:\n  mtplx: { adapter: mtplx, port: ${port} }\nmodels:\n  quality: { runtime: mtplx, backend_model: Vendor/Some-Model }`,
        fakeLocation(),
      );
      service = createDockService({ config, registry, logger, readyTimeoutMs: 20_000 });

      const response = await service.proxy({
        path: 'chat/completions',
        body: JSON.stringify({ model: 'quality', messages: [] }),
        headers: {},
        signal: new AbortController().signal,
        requestId: 'empty-models',
      });
      const body = JSON.parse(response.text ?? (await readAll(response.stream))) as {
        received_model: string;
      };
      expect(body.received_model).toBe('Vendor/Some-Model');
      expect(service.status().resident?.ownership).toBe('spawned');
    } finally {
      await server.stop();
    }
  });
});
