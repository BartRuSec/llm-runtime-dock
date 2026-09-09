import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, parseConfig } from '@llm-runtime-dock/core';
import type { ConfigLocation } from '@llm-runtime-dock/core';
import { createOmlxAdapter } from '../src/index.js';

/**
 * The two payload shapes oMLX actually serves (spec §17, §20).
 *
 * These bodies are captured verbatim from a real oMLX server, because the two
 * keys below are exactly where this adapter has drifted from it: residency is
 * `models`, not the `data` that `/v1/models` uses, and the context window is
 * `max_model_len`, not the OpenAI-conventional `context_length`. Reading either
 * wrong key yields `undefined` rather than a type error — the first failed
 * every acquire with `RUNTIME_MODEL_MISMATCH`, the second reported no context
 * length at all — so the shape has to be pinned somewhere that is not the
 * fixture, which encoded the same guess.
 */

const location = (): ConfigLocation => ({
  path: join(tmpdir(), 'omlx.yaml'),
  found: true,
  candidates: [],
  source: 'flag',
});
const adapter = createOmlxAdapter({ binary: 'omlx' });

/** Serves the captured bodies, keyed by path. */
const serving = async (
  routes: Record<string, unknown>,
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const body = routes[path];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const statusBody = (loaded: boolean, pinned = false) => ({
  final_ceiling: 54487466992,
  current_model_memory: 0,
  model_count: 1,
  loaded_count: loaded ? 1 : 0,
  models: [
    {
      id: 'Llama-3.2-1B-Instruct-4bit',
      model_path: '/Users/someone/.omlx/models/mlx-community/Llama-3.2-1B-Instruct-4bit',
      loaded,
      is_loading: false,
      pinned,
      engine_type: 'batched',
      model_type: 'llm',
      model_context_length: 131072,
      max_context_window: 131072,
      max_tokens: 32768,
    },
  ],
});

const modelsBody = {
  object: 'list',
  data: [
    {
      id: 'Llama-3.2-1B-Instruct-4bit',
      object: 'model',
      created: 1788722411,
      owned_by: 'omlx',
      max_model_len: 131072,
    },
  ],
};

const entryFor = (port: number) =>
  parseConfig(
    createAdapterRegistry([adapter]),
    `runtimes:\n  omlx: { adapter: omlx, port: ${port} }\nmodels:\n  small: { runtime: omlx, backend_model: Llama-3.2-1B-Instruct-4bit }`,
    location(),
  ).models.get('small')!;

describe('omlx payload shapes', () => {
  it('reads residency out of the `models` array, not `data`', async () => {
    const server = await serving({ '/v1/models/status': statusBody(true) });
    try {
      const check = await adapter.verifyIdentity(entryFor(server.port));
      expect(check.ok).toBe(true);
      expect(check.served).toEqual(['Llama-3.2-1B-Instruct-4bit']);
    } finally {
      await server.close();
    }
  });

  it('accepts a second resident model only when it is one another entry keeps', async () => {
    // Two models loaded on one server is normally a broken §8 invariant. It is
    // legitimate exactly when the other one carries `keep_resident`, which is
    // what `keepLoaded` names.
    const twoLoaded = {
      ...statusBody(true),
      loaded_count: 2,
      models: [
        ...statusBody(true).models,
        { ...statusBody(true).models[0]!, id: 'coder-35b', loaded: true },
      ],
    };
    const server = await serving({ '/v1/models/status': twoLoaded });
    try {
      const entry = entryFor(server.port);
      expect((await adapter.verifyIdentity(entry)).ok).toBe(false);
      expect((await adapter.verifyIdentity(entry, { keepLoaded: ['coder-35b'] })).ok).toBe(true);
      // A different stray is still a stray, kept set or not.
      expect((await adapter.verifyIdentity(entry, { keepLoaded: ['something-else'] })).ok).toBe(
        false,
      );
    } finally {
      await server.close();
    }
  });

  it('still rejects a server that reports the model as not loaded', async () => {
    const server = await serving({ '/v1/models/status': statusBody(false) });
    try {
      const check = await adapter.verifyIdentity(entryFor(server.port));
      expect(check.ok).toBe(false);
      expect(check.detail).toContain('loaded_count=0');
    } finally {
      await server.close();
    }
  });

  it('carries `loaded` and `pinned` through listModels, which doctor warns on', async () => {
    const server = await serving({ '/v1/models/status': statusBody(true, true) });
    try {
      expect(await adapter.listModels(entryFor(server.port))).toEqual([
        { id: 'Llama-3.2-1B-Instruct-4bit', loaded: true, pinned: true },
      ]);
    } finally {
      await server.close();
    }
  });

  it('takes the context window from `max_model_len` when probing', async () => {
    const server = await serving({
      '/health': { status: 'healthy' },
      '/v1/models/status': statusBody(false),
      '/v1/models': modelsBody,
    });
    try {
      const result = await adapter.probe({ url: `http://127.0.0.1:${server.port}` });
      // `models` lives only on the `running` variant of the union, so narrow
      // rather than assert on `status` — vitest does not typecheck, `tsc` does.
      if (result.status !== 'running') throw new Error(`probe reported ${result.status}`);
      expect(result.models[0]?.contextLength).toBe(131072);
    } finally {
      await server.close();
    }
  });
});
