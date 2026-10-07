import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCustomAdapter } from '@llm-runtime-dock/adapter-custom';
import { startGateway, type RunningGateway } from '@llm-runtime-dock/gateway';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
  type UsageSnapshot,
} from '@llm-runtime-dock/core';
import { FAKE_RUNTIME, fakeLocation, freePort } from '../helpers/env.js';
import { fakeRuntimeEnv } from '../helpers/fake-runtime.js';

/**
 * Per-model token counters: what the upstream reported, surfaced on `/status`
 * with no `--debug` and no change to the request.
 */

const logger = createLogger({ level: 'error', write: () => {} });

const runtimeBlock = (id: string, model: string, port: number): string => {
  const env = fakeRuntimeEnv({ port, model });
  return `
  ${id}:
    adapter: custom
    process:
      start:
        command: ["${process.execPath}", "${FAKE_RUNTIME}"]
      env:
${Object.entries(env)
  .map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`)
  .join('\n')}
      startup_timeout_ms: 10000
    health: { url: "http://127.0.0.1:${port}/health" }
    model_discovery: { url: "http://127.0.0.1:${port}/v1/models" }
    endpoint: { url: "http://127.0.0.1:${port}/v1" }
    surfaces: [openai, anthropic]
`;
};

describe('token usage counters', () => {
  let gateway: RunningGateway;

  beforeEach(async () => {
    const gatewayPort = await freePort();
    const port = await freePort();
    const registry = createAdapterRegistry([createCustomAdapter({ logger })]);
    const config = parseConfig(
      registry,
      `
server: { host: 127.0.0.1, port: ${gatewayPort} }
runtimes:${runtimeBlock('alpha', 'alpha-model', port)}
models:
  alpha: { runtime: alpha, backend_model: alpha-model }`,
      fakeLocation(),
    );
    const service = createDockService({
      config,
      registry,
      logger,
      readyTimeoutMs: 15_000,
      drainTimeoutMs: 3_000,
    });
    gateway = await startGateway({ service, logger });
  });

  afterEach(async () => {
    await gateway.close();
  });

  const post = async (path: string, body: Record<string, unknown>): Promise<string> => {
    const response = await fetch(`${gateway.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'alpha',
        messages: [{ role: 'user', content: 'hi' }],
        ...body,
      }),
    });
    return await response.text();
  };

  const alpha = async () => {
    const usage = (await (await fetch(`${gateway.url}/usage`)).json()) as UsageSnapshot;
    return usage.models['alpha'];
  };

  it('adds up JSON and streamed answers from both surfaces, and flags a stream with none', async () => {
    await post('/v1/chat/completions', {});
    expect(await alpha()).toMatchObject({ requests: 1, input: 5, output: 7 });

    await post('/v1/chat/completions', { stream: true, stream_options: { include_usage: true } });
    await post('/v1/messages', { stream: true, max_tokens: 16 });
    expect(await alpha()).toMatchObject({ requests: 3, input: 15, output: 21 });

    // The gateway adds no `stream_options`, so this stream carries no usage.
    await post('/v1/chat/completions', { stream: true });
    expect(await alpha()).toEqual({
      requests: 4,
      input: 15,
      output: 21,
      cached: 0,
      noUsage: 1,
      failed: 0,
    });

    // A token-counting call generates nothing, so it is not served usage.
    await post('/v1/messages/count_tokens', {});
    expect((await alpha())?.requests).toBe(4);
  });

  it('keeps the counters out of /status', async () => {
    await post('/v1/chat/completions', {});
    const status = (await (await fetch(`${gateway.url}/status`)).json()) as Record<string, unknown>;
    expect(status).not.toHaveProperty('usage');
  });
});
