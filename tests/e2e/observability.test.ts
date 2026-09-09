import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCustomAdapter } from '@llm-runtime-dock/adapter-custom';
import { startGateway, type RunningGateway } from '@llm-runtime-dock/gateway';
import {
  createAdapterRegistry,
  createDebugTap,
  createDockService,
  createLogger,
  parseConfig,
  type DebugTap,
} from '@llm-runtime-dock/core';
import { FAKE_RUNTIME, fakeLocation, freePort, tempDir, waitFor } from '../helpers/env.js';
import { fakeRuntimeEnv } from '../helpers/fake-runtime.js';

/**
 * The two things the gateway shows about itself: what it actually forwarded
 * (§14, `lrd serve --debug`), and that a client which walks away mid-stream
 * hands the resident slot back (§8, §24).
 */

const logger = createLogger({ level: 'error', write: () => {} });

/** The declared runtime: the server, its command and its URLs. */
const runtime = (
  id: string,
  model: string,
  port: number,
  stream: { padBytes?: number; streamChunks?: number } = {},
): string => {
  const env = fakeRuntimeEnv({
    port,
    model,
    ...(stream.padBytes
      ? {
          streamPadBytes: stream.padBytes,
          streamChunks: stream.streamChunks ?? 200,
          streamDelayMs: 0,
        }
      : {}),
  });
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

/** The model on it: the reference the runtime understands, and nothing else. */
const entry = (id: string, model: string): string => `
  ${id}: { runtime: ${id}, backend_model: ${model} }`;

interface Harness {
  gateway: RunningGateway;
  base: string;
  tap: DebugTap;
  capture: () => Array<Record<string, unknown>>;
  cleanup: () => void;
}

const startHarness = async (
  options: { padBytes?: number; streamChunks?: number } = {},
): Promise<Harness> => {
  const gatewayPort = await freePort();
  const portA = await freePort();
  const portB = await freePort();
  const dir = tempDir();
  const registry = createAdapterRegistry([createCustomAdapter({ logger })]);
  const config = parseConfig(
    registry,
    `
server: { host: 127.0.0.1, port: ${gatewayPort} }
runtimes:${runtime('alpha', 'alpha-model', portA, options)}${runtime('beta', 'beta-model', portB)}
models:${entry('alpha', 'alpha-model')}${entry('beta', 'beta-model')}`,
    fakeLocation(),
  );
  const tap = createDebugTap({ dir: dir.path, logger });
  const service = createDockService({
    config,
    registry,
    logger,
    readyTimeoutMs: 15_000,
    // Short, so a lease that was never handed back fails the test quickly
    // instead of hiding behind the production timeout.
    drainTimeoutMs: 3_000,
    tap,
  });
  const gateway = await startGateway({ service, logger, tap });

  return {
    gateway,
    base: gateway.url,
    tap,
    capture: () =>
      readFileSync(tap.path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    cleanup: dir.cleanup,
  };
};

describe('lrd serve --debug', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.gateway.close();
    await harness.tap.close();
    harness.cleanup();
  });

  it('captures what went upstream, with the model resolved and the credential gone', async () => {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-token-123' },
      body: JSON.stringify({ model: 'alpha', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const received = (await response.json()) as { received_body: Record<string, unknown> };
    await harness.tap.close();

    const request = harness.capture().find((line) => line.event === 'request')!;
    // The capture is of the upstream hop, so it holds the served id — which is
    // exactly the byte-level answer to "did the gateway change my request".
    expect(JSON.parse(request.body as string)).toEqual(received.received_body);
    expect(request.servedModel).toBe('alpha-model');
    expect(request.runtime).toBe('alpha');

    // Headers are redacted; bodies are not, because the body is the thing being
    // inspected. This fixture echoes the credential back inside its response, so
    // the file genuinely holds the token — which is why `serve --debug` says on
    // every run that the capture is sensitive.
    expect((request.headers as Record<string, string>).authorization).toBe('[redacted]');
    expect(JSON.stringify(request)).not.toContain('client-token-123');
  });

  it('records both hops of a stream, so the relay can be checked rather than assumed', async () => {
    const response = await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha', messages: [], stream: true }),
    });
    const client = await response.text();
    await harness.tap.close();

    const lines = harness.capture();
    const textOf = (hop: string): string =>
      lines
        .filter((line) => line.event === 'body' && line.hop === hop)
        .map((line) => (line.text as string) ?? '')
        .join('');

    expect(textOf('upstream')).toBe(client);
    // Capturing only the upstream hop would take the 1:1 relay on faith; this
    // is the assertion that would fail if the pump ever stopped being one.
    expect(textOf('client')).toBe(client);
    expect(lines.at(-1)).toMatchObject({ event: 'end', reason: 'complete' });
  });

  it('records the status and shows which headers the gateway itself removed', async () => {
    await fetch(`${harness.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alpha', messages: [] }),
    });
    await harness.tap.close();

    const line = harness.capture().find((entry) => entry.event === 'response')!;
    expect(line.status).toBe(200);
    const upstream = line.headers as Record<string, string>;
    const forwarded = line.forwarded as Record<string, string>;
    expect(upstream['content-type']).toContain('application/json');
    // The upstream answers chunked over a keep-alive connection. Both headers
    // describe *that* hop and must not be re-emitted on this one; the pair of
    // fields is what makes the removal visible rather than mysterious.
    expect(upstream['transfer-encoding']).toBe('chunked');
    expect(forwarded['transfer-encoding']).toBeUndefined();
    expect(forwarded['connection']).toBeUndefined();
    expect(forwarded['content-type']).toContain('application/json');
  });
});

describe('a client that walks away mid-stream', () => {
  let harness: Harness;

  beforeEach(async () => {
    // 64 KiB per chunk and a thousand of them: far more than any socket buffer
    // can absorb, so a client that never reads parks the gateway's pump on a
    // `drain` that will not come until it reads. Nothing is wasted by the size
    // — once parked, the pump stops pulling and the fake runtime blocks too.
    harness = await startHarness({ padBytes: 65_536, streamChunks: 1_000 });
  });

  afterEach(async () => {
    await harness.gateway.close();
    await harness.tap.close();
    harness.cleanup();
  });

  const activeRequests = async (): Promise<number> => {
    const status = (await (await fetch(`${harness.base}/status`)).json()) as {
      resident: { modelId: string; activeRequests: number } | null;
    };
    return status.resident?.activeRequests ?? 0;
  };

  it('hands the resident slot back instead of parking on a drain that never comes', async () => {
    const url = new URL(harness.base);
    const body = JSON.stringify({ model: 'alpha', messages: [], stream: true });
    const socket = connect(Number(url.port), url.hostname);

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          `POST /v1/chat/completions HTTP/1.1\r\n` +
            `host: ${url.host}\r\n` +
            `content-type: application/json\r\n` +
            `content-length: ${Buffer.byteLength(body)}\r\n` +
            `connection: close\r\n\r\n${body}`,
        );
        resolve();
      });
    });
    // Deliberately never read from `socket`: the client's receive buffer fills,
    // TCP closes the window, and the gateway's `res.write` starts returning false.
    socket.pause();

    await waitFor(async () => (await activeRequests()) >= 1, { timeoutMs: 20_000 });
    // The precondition this test depends on: the request is still in flight and
    // wedged, not quietly finished. Without it the test would pass for the wrong
    // reason, which is exactly how it first fooled me.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await activeRequests()).toBeGreaterThanOrEqual(1);

    // A destroyed socket never emits `drain`. Waiting on it alone parks the pump
    // forever, so the lease is never handed back and the slot stays occupied
    // until the drain timeout (§8, §24).
    socket.destroy();

    await waitFor(async () => (await activeRequests()) === 0, { timeoutMs: 5_000 });

    // And the slot is genuinely usable again, through the scheduler.
    const switched = await fetch(`${harness.base}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'beta' }),
    });
    expect(switched.status).toBe(200);
    const status = (await switched.json()) as { resident: { modelId: string } | null };
    expect(status.resident?.modelId).toBe('beta');
  });
});
