import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCustomAdapter } from '@llm-runtime-dock/adapter-custom';
import {
  createGateway,
  isLoopbackAddress,
  startGateway,
  type RunningGateway,
} from '@llm-runtime-dock/gateway';
import {
  createAdapterRegistry,
  createDockService,
  createLogger,
  parseConfig,
} from '@llm-runtime-dock/core';
import { FAKE_RUNTIME, fakeLocation, freePort } from '../helpers/env.js';
import { fakeRuntimeEnv } from '../helpers/fake-runtime.js';

/** The HTTP surface (spec §14) end to end, over a real socket. */

const logger = createLogger({ level: 'error', write: () => {} });

/** The declared runtime: the server, its command and its URLs. */
const runtime = (id: string, model: string, port: number, extra = ''): string => {
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
    endpoint: { url: "http://127.0.0.1:${port}/v1" }${extra}
`;
};

/** The model on it: the reference the runtime understands, and nothing else. */
const entry = (id: string, model: string): string => `
  ${id}: { runtime: ${id}, backend_model: ${model} }`;

describe('gateway HTTP surface', () => {
  let gateway: RunningGateway;
  let base: string;

  beforeEach(async () => {
    const gatewayPort = await freePort();
    const portA = await freePort();
    const portB = await freePort();
    // A configured entry that is never served (§12). Its runtime is declared in
    // full so that nothing about the *shape* of the config explains the
    // exclusion — only the flag does. Nothing ever spawns it.
    const portC = await freePort();
    const registry = createAdapterRegistry([createCustomAdapter({ logger })]);
    const config = parseConfig(
      registry,
      `
server: { host: 127.0.0.1, port: ${gatewayPort} }
runtimes:${runtime('alpha', 'alpha-model', portA, '\n    surfaces: [openai, anthropic]')}${runtime('beta', 'beta-model', portB, '\n    surfaces: [openai, anthropic]')}${runtime('gamma', 'gamma-model', portC, '\n    surfaces: [openai, anthropic]')}
models:${entry('alpha', 'alpha-model')}${entry('beta', 'beta-model')}
  gamma: { runtime: gamma, backend_model: gamma-model, disabled: true }`,
      fakeLocation(),
    );
    const service = createDockService({ config, registry, logger, readyTimeoutMs: 15_000 });
    gateway = await startGateway({ service, logger });
    base = gateway.url;
  });

  afterEach(async () => {
    await gateway.close();
  });

  it('serves /health and /v1/models with the configured logical ids', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    const models = await fetch(`${base}/v1/models`);
    const body = (await models.json()) as {
      object: string;
      data: Array<{ id: string; owned_by: string }>;
    };
    expect(body.object).toBe('list');
    // A model that is not currently loaded still appears (§15).
    // A model that is not currently loaded still appears; a disabled one does
    // not (§12, §15).
    expect(body.data.map((m) => m.id).sort()).toEqual(['alpha', 'beta']);
    expect(body.data[0]?.owned_by).toBe('llm-runtime-dock');
  });

  it('refuses a disabled model with 404 and never starts its runtime', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gamma', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    // Not "unknown model": the entry is plainly in the file, and saying so is
    // the difference between a typo and a deliberate flag.
    expect(body.error.message).toContain('disabled');

    // The refusal happens ahead of the scheduler, so nothing was loaded either.
    const status = await fetch(`${base}/status`);
    const state = (await status.json()) as { resident: unknown; models: string[] };
    expect(state.resident).toBeNull();
    expect(state.models).toEqual(['alpha', 'beta']);
  });

  it('proxies chat completions and resolves the logical id to the backend model', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      received_model: string;
      received_body: Record<string, unknown>;
    };
    expect(body.received_model).toBe('alpha-model');
    // Only the model field is rewritten; nothing else is added or removed.
    expect(body.received_body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(Object.keys(body.received_body).sort()).toEqual(['messages', 'model']);
  });

  it('accepts the namespaced form of a logical id', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llm-runtime-dock/alpha', messages: [] }),
    });
    expect(response.status).toBe(200);
  });

  it('forwards the client Authorization header to the upstream unchanged', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-token-123' },
      body: JSON.stringify({ model: 'alpha', messages: [] }),
    });
    const body = (await response.json()) as { received_authorization: string };
    expect(body.received_authorization).toBe('Bearer client-token-123');
  });

  it('streams SSE through unaltered', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha', messages: [], stream: true }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('data: {');
    expect(text).toContain('chunk0');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('routes an Anthropic request exactly like a chat-completions one', async () => {
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'beta',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 16,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string; received_model: string };
    expect(body.type).toBe('message');
    expect(body.received_model).toBe('beta-model');

    // The same entry is resident; the surfaces share the slot and the scheduler.
    const status = (await (await fetch(`${base}/status`)).json()) as {
      resident: { modelId: string };
    };
    expect(status.resident.modelId).toBe('beta');
  });

  it('passes an Anthropic stream through without rewriting its events', async () => {
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha', messages: [], stream: true }),
    });
    const text = await response.text();
    // Anthropic event names survive; they are never turned into OpenAI chunks.
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('event: message_stop');
    expect(text).not.toContain('[DONE]');
  });

  it('proxies count_tokens', async () => {
    const response = await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha', messages: [] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { input_tokens: number };
    expect(body.input_tokens).toBe(42);
  });

  it('answers /status and switches through the scheduler on /switch', async () => {
    const before = (await (await fetch(`${base}/status`)).json()) as {
      resident: unknown;
      queueDepth: number;
    };
    expect(before.resident).toBeNull();
    expect(before.queueDepth).toBe(0);

    const switched = await fetch(`${base}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'beta' }),
    });
    expect(switched.status).toBe(200);
    const status = (await switched.json()) as { resident: { modelId: string; state: string } };
    expect(status.resident.modelId).toBe('beta');
    expect(status.resident.state).toBe('ready');
  });

  it('returns an OpenAI-style error for an unknown model', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [] }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; type: string; message: string };
    };
    expect(body.error.code).toBe('MODEL_NOT_FOUND');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('nope');
  });

  it('rejects /switch without a model', async () => {
    const response = await fetch(`${base}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });

  it('assigns a request id and echoes a supplied one', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.headers.get('x-request-id')).toBeTruthy();

    const withId = await fetch(`${base}/v1/models`, { headers: { 'x-request-id': 'mine-123' } });
    expect(withId.headers.get('x-request-id')).toBe('mine-123');
  });
});

describe('loopback-only lifecycle controls', () => {
  const serve = async (bindHost: string): Promise<{ url: string; close: () => Promise<void> }> => {
    const port = await freePort();
    const registry = createAdapterRegistry([createCustomAdapter({ logger })]);
    const config = parseConfig(
      registry,
      `server: { host: ${bindHost}, port: ${port} }\nmodels: {}`,
      fakeLocation(),
    );
    const service = createDockService({ config, registry, logger });
    // The server is told it is bound to `bindHost` — which is what the refusal
    // is about — while actually listening on loopback so the test can reach it.
    const server = createGateway({ service, logger, host: bindHost, port });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await service.shutdown();
      },
    };
  };

  it('serves /status and /switch on a loopback bind', async () => {
    const gateway = await serve('127.0.0.1');
    try {
      expect((await fetch(`${gateway.url}/status`)).status).toBe(200);
    } finally {
      await gateway.close();
    }
  });

  it('refuses them outright on a non-loopback bind', async () => {
    const gateway = await serve('0.0.0.0');
    try {
      const status = await fetch(`${gateway.url}/status`);
      expect(status.status).toBe(403);
      const body = (await status.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('loopback_only');
      expect(body.error.message).toContain('0.0.0.0');

      const switched = await fetch(`${gateway.url}/switch`, {
        method: 'POST',
        body: JSON.stringify({ model: 'anything' }),
      });
      expect(switched.status).toBe(403);

      // Inference is unaffected: only the lifecycle controls are refused.
      expect((await fetch(`${gateway.url}/health`)).status).toBe(200);
      expect((await fetch(`${gateway.url}/v1/models`)).status).toBe(200);
    } finally {
      await gateway.close();
    }
  });

  it('classifies loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
