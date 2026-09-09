import { afterEach, describe, expect, it } from 'vitest';
import { createCustomAdapter } from '@llm-runtime-dock/adapter-custom';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
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
  FAKE_RUNTIME,
  fakeLocation,
  fixtureCli,
  freePort,
  readAll,
  waitFor,
} from '../helpers/env.js';
import { fakeRuntimeEnv } from '../helpers/fake-runtime.js';

/** Failure handling (spec §25) and readiness semantics (§16). */

const logger = createLogger({ level: 'error', write: () => {} });

/** The declared runtime: the process to run and the URLs it answers on. */
const customRuntime = (
  id: string,
  port: number,
  env: Record<string, string>,
  extra = '',
): string => {
  const envLines = Object.entries(env)
    .map(([key, value]) => `        ${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return `
  ${id}:
    adapter: custom
    process:
      start:
        command: ["${process.execPath}", "${FAKE_RUNTIME}"]
      env:
${envLines}
      startup_timeout_ms: 8000
      shutdown_timeout_ms: 5000
    health: { url: "http://127.0.0.1:${port}/health" }
    model_discovery: { url: "http://127.0.0.1:${port}/v1/models" }
    endpoint: { url: "http://127.0.0.1:${port}/v1" }${extra}
`;
};

interface CustomFixture {
  readonly id: string;
  readonly port: number;
  readonly env: Record<string, string>;
  readonly extra?: string;
}

/**
 * A whole configuration for N custom runtimes with one model each.
 *
 * The two sections are written together because a model and the server that
 * serves it are declared in different places, and interleaving them by hand in
 * every fixture would be the only thing these tests were about.
 */
const customConfig = (...entries: CustomFixture[]): string =>
  `runtimes:${entries.map((e) => customRuntime(e.id, e.port, e.env, e.extra ?? '')).join('')}
models:${entries
    .map(
      (e) =>
        `\n  ${e.id}: { runtime: ${e.id}, backend_model: ${e.env.FAKE_SERVE_MODEL ?? e.env.FAKE_MODEL ?? 'fake-model'} }`,
    )
    .join('')}
`;

const serviceFor = (yaml: string, overrides: { readyTimeoutMs?: number } = {}): DockService => {
  const registry = createAdapterRegistry([
    createCustomAdapter({ logger }),
    createMtplxAdapter({ ...fixtureCli(FAKE_MTPLX), logger, startupTimeoutMs: 20_000 }),
  ]);
  return createDockService({
    config: parseConfig(registry, yaml, fakeLocation()),
    registry,
    logger,
    readyTimeoutMs: overrides.readyTimeoutMs ?? 15_000,
    drainTimeoutMs: 15_000,
  });
};

const post = async (service: DockService, model: string, signal?: AbortSignal): Promise<number> => {
  const controller = new AbortController();
  const response = await service.proxy({
    path: 'chat/completions',
    body: JSON.stringify({ model, messages: [] }),
    headers: {},
    signal: signal ?? controller.signal,
    requestId: `req-${model}`,
  });
  await readAll(response.stream);
  return response.status;
};

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    return (error as GatewayError).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
};

describe('failure handling', () => {
  // Every runtime in this file is spawned by the gateway itself, so shutting the
  // services down is the whole cleanup.
  const services: DockService[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.shutdown().catch(() => {});
  });

  it('treats a 503 loading answer as loading, not as a failure', async () => {
    const port = await freePort();
    const service = serviceFor(
      customConfig({
        id: 'slow',
        port,
        env: fakeRuntimeEnv({ port, model: 'slow-model', loadingMs: 700 }),
      }),
    );
    services.push(service);

    // The port binds immediately and answers 503 for 700ms. That must be waited
    // through, not reported as failed.
    expect(await post(service, 'slow')).toBe(200);
    expect(service.status().resident?.state).toBe('ready');
  });

  it('fails with RUNTIME_MODEL_MISMATCH when the wrong model is served', async () => {
    const port = await freePort();
    const env = fakeRuntimeEnv({ port, model: 'expected', serveModel: 'something-else' });
    const service = serviceFor(`
runtimes:
  custom:
    adapter: custom
    process:
      start:
        command: ["${process.execPath}", "${FAKE_RUNTIME}"]
      env:
${Object.entries(env)
  .map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`)
  .join('\n')}
      startup_timeout_ms: 8000
    health: { url: "http://127.0.0.1:${port}/health" }
    model_discovery: { url: "http://127.0.0.1:${port}/v1/models" }
    endpoint: { url: "http://127.0.0.1:${port}/v1" }
models:
  wrong: { runtime: custom, backend_model: expected }
`);
    services.push(service);

    expect(await codeOf(() => post(service, 'wrong'))).toBe('RUNTIME_MODEL_MISMATCH');
    // Never silently proxy to a different model than requested.
    expect(service.status().resident).toBeNull();
  });

  it('fails with RUNTIME_READY_TIMEOUT when the runtime never becomes ready', async () => {
    const port = await freePort();
    const env = fakeRuntimeEnv({ port, model: 'm', loadingMs: 60_000 });
    const service = serviceFor(
      customConfig({ id: 'never', port, env }).replace(
        'startup_timeout_ms: 8000',
        'startup_timeout_ms: 900',
      ),
      { readyTimeoutMs: 900 },
    );
    services.push(service);

    expect(await codeOf(() => post(service, 'never'))).toBe('RUNTIME_READY_TIMEOUT');
  });

  it('fails with RUNTIME_START_FAILED when the executable does not exist', async () => {
    const port = await freePort();
    const service = serviceFor(`
runtimes:
  custom:
    adapter: custom
    process:
      start: { command: ["/definitely/not/a/real/binary", "serve"] }
      startup_timeout_ms: 1500
    health: { url: "http://127.0.0.1:${port}/health" }
    model_discovery: { url: "http://127.0.0.1:${port}/v1/models" }
    endpoint: { url: "http://127.0.0.1:${port}/v1" }
models:
  missing: { runtime: custom, backend_model: m }
`);
    services.push(service);

    const code = await codeOf(() => post(service, 'missing'));
    expect(['RUNTIME_START_FAILED', 'RUNTIME_READY_TIMEOUT']).toContain(code);
  });

  it('recovers after a runtime crashes while serving', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const service = serviceFor(
      customConfig(
        { id: 'crashy', port: portA, env: fakeRuntimeEnv({ port: portA, model: 'crashy-model' }) },
        { id: 'stable', port: portB, env: fakeRuntimeEnv({ port: portB, model: 'stable-model' }) },
      ),
    );
    services.push(service);

    expect(await post(service, 'crashy')).toBe(200);

    // Kill the runtime out from under the gateway.
    await fetch(`http://127.0.0.1:${portA}/__shutdown`).catch(() => {});
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${portA}/health`);
        return false;
      } catch {
        return true;
      }
    });

    // The next request for the same entry reports the upstream failure...
    const code = await codeOf(() => post(service, 'crashy'));
    expect(['UPSTREAM_UNAVAILABLE', 'RUNTIME_START_FAILED']).toContain(code);

    // ...and the slot must not stay wedged behind a corpse: a different model
    // still becomes resident.
    expect(await post(service, 'stable')).toBe(200);
    expect(service.status().resident?.modelId).toBe('stable');
  });

  it('fails an unknown model with MODEL_NOT_FOUND', async () => {
    const port = await freePort();
    const service = serviceFor(
      customConfig({ id: 'known', port, env: fakeRuntimeEnv({ port, model: 'm' }) }),
    );
    services.push(service);
    expect(await codeOf(() => post(service, 'nope'))).toBe('MODEL_NOT_FOUND');
  });

  it('fails an Anthropic request on a runtime that serves only OpenAI', async () => {
    const port = await freePort();
    const service = serviceFor(
      customConfig({
        id: 'openai-only',
        port,
        env: fakeRuntimeEnv({ port, model: 'm', surfaces: ['openai'] }),
      }),
    );
    services.push(service);

    const controller = new AbortController();
    const code = await codeOf(() =>
      service.proxy({
        path: 'messages',
        body: JSON.stringify({ model: 'openai-only', messages: [] }),
        headers: {},
        signal: controller.signal,
        requestId: 'anthropic-1',
      }),
    );
    // The custom adapter declares OpenAI only unless the entry opts in.
    expect(code).toBe('UPSTREAM_SURFACE_UNSUPPORTED');
  });

  it('releases a cancelled request without wedging the queue', async () => {
    const port = await freePort();
    const service = serviceFor(
      customConfig({
        id: 'cancel-me',
        port,
        env: fakeRuntimeEnv({ port, model: 'm', streamChunks: 50, streamDelayMs: 40 }),
      }),
    );
    services.push(service);

    const controller = new AbortController();
    const response = await service.proxy({
      path: 'chat/completions',
      body: JSON.stringify({ model: 'cancel-me', messages: [], stream: true }),
      headers: {},
      signal: controller.signal,
      requestId: 'stream-cancel',
    });
    expect(response.status).toBe(200);
    expect(service.status().resident?.activeRequests).toBe(1);

    // A client that disconnects cancels the stream; the lease must be released.
    await response.stream?.cancel();
    await waitFor(() => service.status().resident?.activeRequests === 0);

    // The runtime is still resident and usable.
    expect(await post(service, 'cancel-me')).toBe(200);
  });

  it('rejects a queued request when its client goes away before the pump reaches it', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const service = serviceFor(
      customConfig(
        {
          id: 'first',
          port: portA,
          env: fakeRuntimeEnv({ port: portA, model: 'a', streamChunks: 30, streamDelayMs: 30 }),
        },
        { id: 'second', port: portB, env: fakeRuntimeEnv({ port: portB, model: 'b' }) },
      ),
    );
    services.push(service);

    const streamController = new AbortController();
    const stream = await service.proxy({
      path: 'chat/completions',
      body: JSON.stringify({ model: 'first', messages: [], stream: true }),
      headers: {},
      signal: streamController.signal,
      requestId: 'holding',
    });

    // Two queued requests: the pump takes the first and blocks on the drain,
    // leaving the second genuinely queued and droppable on abort.
    const firstQueued = post(service, 'second');
    const secondController = new AbortController();
    const secondQueued = post(service, 'second', secondController.signal);
    await waitFor(() => service.status().queueDepth >= 2);

    secondController.abort();
    let thrown: unknown;
    try {
      await secondQueued;
    } catch (error) {
      thrown = error;
    }
    const error = thrown as GatewayError;
    expect(error.code).toBe('RUNTIME_SLOT_BUSY');
    // The message distinguishes cancellation from genuine slot contention.
    expect(error.details.reason).toBe('client_cancelled');

    // The switch already in flight is not abandoned: draining still waits for
    // the active stream, and the other queued request is served afterwards.
    await stream.stream?.cancel();
    expect(await firstQueued).toBe(200);
    expect(service.status().resident?.modelId).toBe('second');
  });

  it('completes an in-flight switch even when the request that triggered it is cancelled', async () => {
    const portA = await freePort();
    const portB = await freePort();
    const service = serviceFor(
      customConfig(
        {
          id: 'first',
          port: portA,
          env: fakeRuntimeEnv({ port: portA, model: 'a', streamChunks: 8, streamDelayMs: 20 }),
        },
        { id: 'second', port: portB, env: fakeRuntimeEnv({ port: portB, model: 'b' }) },
      ),
    );
    services.push(service);

    const streamController = new AbortController();
    const stream = await service.proxy({
      path: 'chat/completions',
      body: JSON.stringify({ model: 'first', messages: [], stream: true }),
      headers: {},
      signal: streamController.signal,
      requestId: 'holding',
    });

    const queuedController = new AbortController();
    const queued = post(service, 'second', queuedController.signal);
    await waitFor(() => service.status().queueDepth >= 1);

    // The pump has already taken this waiter and is draining, so cancelling it
    // does not abandon the transition: the runtime is left resident so the next
    // request finds it warm.
    queuedController.abort();
    await stream.stream?.cancel();

    expect(await codeOf(() => queued)).toBe('RUNTIME_SLOT_BUSY');
    await waitFor(() => service.status().resident?.modelId === 'second');
    expect(service.status().queueDepth).toBe(0);
  });
});
