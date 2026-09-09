import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, parseConfig } from '@llm-runtime-dock/core';
import type { ConfigLocation } from '@llm-runtime-dock/core';
import { createOllamaAdapter } from '../src/index.js';

const location = (): ConfigLocation => ({
  path: join(tmpdir(), 'ollama.yaml'),
  found: true,
  candidates: [],
  source: 'flag',
});
const adapter = createOllamaAdapter({ binary: 'ollama' });

/**
 * `process.execPath` is an absolute path that exists, so `executableAvailable`
 * reports it without consulting PATH; the other never exists. Between them the
 * probe's "can this adapter spawn a server?" branch is exercised both ways
 * without depending on whether Ollama is installed on the machine running the
 * suite.
 */
const withBinary = createOllamaAdapter({ binary: process.execPath });
const withoutBinary = createOllamaAdapter({ binary: join(tmpdir(), 'lrd-no-such-ollama') });

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
}

const serving = async (
  handler: (path: string, body: string) => Reply,
): Promise<{ url: string; port: number; close: () => Promise<void> }> => {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const reply = handler((req.url ?? '').split('?')[0] ?? '', body);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

/** A port nothing is listening on: bind one, read it back, give it up again. */
const closedPort = async (): Promise<number> => {
  const server = await serving(() => ({}));
  await server.close();
  return server.port;
};

const entryFor = (port: number, backendModel = 'llama3.2') =>
  parseConfig(
    createAdapterRegistry([adapter]),
    [
      'runtimes:',
      `  ollama: { adapter: ollama, port: ${port} }`,
      'models:',
      '  small:',
      '    runtime: ollama',
      `    backend_model: "${backendModel}"`,
    ].join('\n'),
    location(),
  ).models.get('small')!;

describe('ollama payloads', () => {
  it('normalizes latest tags and sends keep_alive load and release payloads', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = await serving((path, raw) => {
      if (path === '/api/generate') {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        return { body: { done: true } };
      }
      return { body: { models: [{ name: 'llama3.2:latest' }] } };
    });
    try {
      const entry = entryFor(server.port);
      expect((await adapter.verifyIdentity(entry)).ok).toBe(true);
      await adapter.release(entry);
      expect(bodies).toEqual([{ model: 'llama3.2', keep_alive: 0 }]);
    } finally {
      await server.close();
    }
  });

  it('loads with keep_alive -1', async () => {
    let body: Record<string, unknown> | undefined;
    const server = await serving((path, raw) => {
      if (path === '/api/generate') body = JSON.parse(raw) as Record<string, unknown>;
      return { body: { models: [{ name: 'llama3.2:latest' }] } };
    });
    try {
      await adapter.acquire(entryFor(server.port));
      expect(body).toEqual({ model: 'llama3.2', keep_alive: -1 });
    } finally {
      await server.close();
    }
  });

  it('keeps a registry-qualified model resident instead of unloading it', async () => {
    // `localhost:5000/mymodel` carries a registry *port*, not a tag, so a bare
    // `includes(':')` leaves it unnormalized while `/api/ps` answers with
    // `:latest`. The adapter would then read the model it had just loaded as a
    // stray, unload it, and fail the re-check with RUNTIME_MODEL_MISMATCH.
    const generated: Array<Record<string, unknown>> = [];
    const server = await serving((path, raw) => {
      if (path === '/api/generate') {
        generated.push(JSON.parse(raw) as Record<string, unknown>);
        return { body: { done: true } };
      }
      return { body: { models: [{ name: 'localhost:5000/mymodel:latest' }] } };
    });
    try {
      const entry = entryFor(server.port, 'localhost:5000/mymodel');
      await expect(adapter.acquire(entry)).resolves.toEqual({ ownership: 'attached' });
      expect(generated).toEqual([{ model: 'localhost:5000/mymodel', keep_alive: -1 }]);
      expect((await adapter.verifyIdentity(entry)).ok).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('ollama probe', () => {
  it('reports what is resident and what is installed, both tag-qualified', async () => {
    const server = await serving((path) => {
      if (path === '/api/version') return { body: { version: '0.33.3' } };
      if (path === '/api/ps') return { body: { models: [{ name: 'llama3.2:latest' }] } };
      return { body: { models: [{ name: 'llama3.2:latest' }, { model: 'qwen3' }] } };
    });
    try {
      const result = await withBinary.probe({ url: server.url });
      expect(result.status).toBe('running');
      if (result.status !== 'running') return;
      expect(result.models.map((model) => model.id)).toEqual(['llama3.2:latest']);
      // Both halves go through the one normalizer, so a name cannot appear in
      // `models` and `available` under two spellings.
      expect(result.available?.map((model) => model.id)).toEqual([
        'llama3.2:latest',
        'qwen3:latest',
      ]);
    } finally {
      await server.close();
    }
  });

  it('drives a reachable server even when the ollama executable is missing', async () => {
    // Ollama's whole lifecycle is HTTP; the binary is needed only for `serve`.
    // A remote or containerized server is therefore fully usable, and `doctor`
    // is the place that says the gateway could not spawn one.
    const server = await serving((path) => {
      if (path === '/api/version') return { body: { version: '0.33.3' } };
      return { body: { models: [{ name: 'llama3.2:latest' }] } };
    });
    try {
      expect((await withoutBinary.probe({ url: server.url })).status).toBe('running');
    } finally {
      await server.close();
    }
  });

  it('calls a server that does not identify as Ollama foreign, not running', async () => {
    const server = await serving(() => ({ body: { hello: 'not ollama' } }));
    try {
      const result = await withBinary.probe({ url: server.url });
      expect(result.status).toBe('foreign_server');
    } finally {
      await server.close();
    }
  });

  it('reports auth_required rather than not running, at either endpoint', async () => {
    const guarded = await serving((path) =>
      path === '/api/version'
        ? { body: { version: '0.33.3' } }
        : { status: 401, body: { error: 'api key required' } },
    );
    try {
      // The shape a proxy in front of Ollama produces: the version endpoint is
      // open, the catalogue is not.
      expect((await withBinary.probe({ url: guarded.url })).status).toBe('auth_required');
    } finally {
      await guarded.close();
    }
    const sealed = await serving(() => ({ status: 403, body: { error: 'forbidden' } }));
    try {
      expect((await withBinary.probe({ url: sealed.url })).status).toBe('auth_required');
    } finally {
      await sealed.close();
    }
  });

  it('separates "nothing listening" from "nothing installed"', async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    // The binary is there, so a server could be brought up: it is down, not absent.
    expect((await withBinary.probe({ url })).status).toBe('not_running');
    const missing = await withoutBinary.probe({ url });
    expect(missing.status).toBe('not_installed');
    if (missing.status !== 'not_installed') return;
    expect(missing.executable).toContain('lrd-no-such-ollama');
  });
});
