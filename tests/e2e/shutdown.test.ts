import { afterEach, describe, expect, it } from 'vitest';
import { createCustomAdapter } from '@llm-runtime-dock/adapter-custom';
import { startGateway } from '@llm-runtime-dock/gateway';
import type { RunningGateway } from '@llm-runtime-dock/gateway';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import { FAKE_RUNTIME, fakeLocation, freePort } from '../helpers/env.js';

/**
 * Shutting the gateway down must free every loaded model (spec §8).
 *
 * `server.close()` resolves only once every connection has ended, and an SSE
 * stream never ends on its own. Left unbounded, a shutdown during a streaming
 * response never reaches `service.shutdown()`, and every runtime the gateway
 * started is orphaned — still holding the GPU, with nothing left to release it.
 * That is worst for a `keep_resident` entry, which is meant to live exactly as
 * long as the gateway does.
 */

const logger = createLogger({ level: 'error', write: () => {} });

const alive = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    return true;
  } catch {
    return false;
  }
};

describe('gateway shutdown', () => {
  let gateway: RunningGateway | undefined;

  afterEach(async () => {
    await gateway?.close({ graceMs: 0 }).catch(() => {});
    gateway = undefined;
  });

  it('releases a kept runtime even while a response is still streaming', async () => {
    const gatewayPort = await freePort();
    const keptPort = await freePort();
    const registry = createAdapterRegistry([createCustomAdapter({ logger })]);
    const config = parseConfig(
      registry,
      `
server: { host: 127.0.0.1, port: ${gatewayPort} }
runtimes:
  kept:
    adapter: custom
    process:
      start:
        command: ["${process.execPath}", "${FAKE_RUNTIME}"]
      env:
        FAKE_PORT: "${keptPort}"
        FAKE_MODEL: "kept-model"
        FAKE_STREAM_CHUNKS: "2000"
        FAKE_STREAM_DELAY_MS: "50"
      startup_timeout_ms: 10000
    health: { url: "http://127.0.0.1:${keptPort}/health" }
    model_discovery: { url: "http://127.0.0.1:${keptPort}/v1/models" }
    endpoint: { url: "http://127.0.0.1:${keptPort}/v1" }
models:
  kept: { runtime: kept, backend_model: kept-model, keep_resident: true }`,
      fakeLocation(),
    );
    const service = createDockService({ config, registry, logger, readyTimeoutMs: 15_000 });
    gateway = await startGateway({ service, logger });

    // A stream long enough to outlast the shutdown grace, left deliberately
    // unread: this is the client that would otherwise keep the process alive
    // forever.
    const streaming = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kept', stream: true, messages: [] }),
    });
    expect(streaming.status).toBe(200);
    expect(await alive(keptPort)).toBe(true);

    const startedAt = Date.now();
    await gateway.close({ graceMs: 500 });
    gateway = undefined;

    // It finished at all, and it finished by the grace rather than by the
    // stream ending on its own (2000 chunks × 50ms would be 100 seconds).
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(await alive(keptPort)).toBe(false);
    await streaming.body?.cancel().catch(() => {});
  }, 40_000);
});
