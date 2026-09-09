import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLmStudioAdapter } from '@llm-runtime-dock/adapter-lm-studio';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import { createOmlxAdapter } from '@llm-runtime-dock/adapter-omlx';
import { createOllamaAdapter } from '@llm-runtime-dock/adapter-ollama';
import { probeAdapter, saveDiscovery } from '@llm-runtime-dock/core';
import {
  FAKE_LMS,
  FAKE_MTPLX,
  FAKE_OLLAMA,
  FAKE_OMLX,
  fixtureCli,
  freePort,
  tempDir,
} from '../helpers/env.js';
import { startFakeRuntime, type FakeRuntime } from '../helpers/fake-runtime.js';

/**
 * Discovery against real servers (spec §22).
 *
 * Whether `saveDiscovery` merges correctly, and what a preview renders, is
 * core's own logic and is tested there. What needs a live backend is here.
 *
 * Every adapter is pointed at a fixture CLI rather than the real binary. A probe
 * refuses to ask anything over HTTP when the runtime's own executable is
 * missing, so without this the suite would pass or fail depending on what
 * happens to be installed on the machine running it.
 */

const mtplx = () => createMtplxAdapter(fixtureCli(FAKE_MTPLX));
const omlx = () => createOmlxAdapter(fixtureCli(FAKE_OMLX));
const ollama = () => createOllamaAdapter(fixtureCli(FAKE_OLLAMA));
const lmStudio = () => createLmStudioAdapter(fixtureCli(FAKE_LMS));

describe('probe', () => {
  const running: FakeRuntime[] = [];
  let dir: ReturnType<typeof tempDir>;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(async () => {
    for (const server of running.splice(0)) await server.stop();
    dir.cleanup();
  });

  it('reports the models a live backend serves', async () => {
    const port = await freePort();
    running.push(await startFakeRuntime({ port, model: 'qwen38', healthFlavor: 'mtplx' }));

    const outcome = await probeAdapter(mtplx(), { url: `http://127.0.0.1:${port}` });
    expect(outcome.result.status).toBe('running');
    if (outcome.result.status !== 'running') throw new Error('unreachable');
    expect(outcome.result.models.map((m) => m.id)).toEqual(['qwen38']);
  });

  it('reports Ollama installed models separately from its empty resident set', async () => {
    const port = await freePort();
    running.push(
      await startFakeRuntime({
        port,
        multi: true,
        ollama: true,
        models: ['llama3.2', 'qwen2.5-coder:7b'],
      }),
    );
    const outcome = await probeAdapter(ollama(), { url: `http://127.0.0.1:${port}` });
    expect(outcome.result.status).toBe('running');
    if (outcome.result.status !== 'running') throw new Error('unreachable');
    expect(outcome.result.models).toEqual([]);
    // Ollama answers tag-qualified and the adapter normalizes both halves, so a
    // model cannot appear under two spellings between `models` and `available`.
    expect(outcome.result.available?.map((model) => model.id)).toEqual([
      'llama3.2:latest',
      'qwen2.5-coder:7b',
    ]);
  });

  it('reports a dead port as "not running" rather than failing', async () => {
    const port = await freePort();
    const outcome = await probeAdapter(mtplx(), { url: `http://127.0.0.1:${port}` });
    expect(outcome.result.status).toBe('not_running');
  });

  it('reports a server that answers health but demands a credential', async () => {
    const port = await freePort();
    // /health never requires a key; /v1/models does.
    running.push(
      await startFakeRuntime({ port, model: 'a', multi: true, models: ['a'], requireKey: true }),
    );

    const outcome = await probeAdapter(omlx(), { url: `http://127.0.0.1:${port}` });
    expect(outcome.result.status).toBe('auth_required');
  });

  it('accepts a credential and then discovers models', async () => {
    const port = await freePort();
    running.push(
      await startFakeRuntime({ port, multi: true, models: ['a', 'b'], requireKey: true }),
    );

    const outcome = await probeAdapter(omlx(), {
      url: `http://127.0.0.1:${port}`,
      apiKey: 'secret-value',
    });
    expect(outcome.result.status).toBe('running');
    if (outcome.result.status !== 'running') throw new Error('unreachable');
    expect(outcome.result.models.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('skips an id that is not safe to write, and never rewrites the served id', async () => {
    const port = await freePort();
    running.push(
      await startFakeRuntime({ port, multi: true, models: ['good-model', '--rm-rf', 'also/ok:1'] }),
    );

    const outcome = await probeAdapter(omlx(), { url: `http://127.0.0.1:${port}` });
    if (outcome.result.status !== 'running') throw new Error('expected running');
    // `also/ok:1` is kept: only the config key is derived, and the id the
    // server reported — what `backend_model` and §17 use — is untouched.
    expect(outcome.result.models.map((m) => m.id)).toEqual(['good-model', 'also/ok:1']);
    expect(outcome.result.models.map((m) => m.suggestedId)).toEqual(['good-model', 'also-ok:1']);
    // `--rm-rf` reaches an argv, so no key can rescue it.
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]?.id).toBe('--rm-rf');
    expect(outcome.skipped[0]?.reason).toContain('flag');
  });

  it('keeps a publisher-qualified LM Studio id, under a flattened key', async () => {
    const port = await freePort();
    running.push(
      await startFakeRuntime({
        port,
        multi: true,
        models: ['google/gemma-4-26b-a4b-qat', 'lmstudio-community/gemma-4-26b-a4b-qat'],
      }),
    );

    const outcome = await probeAdapter(lmStudio(), {
      url: `http://127.0.0.1:${port}`,
    });
    if (outcome.result.status !== 'running') throw new Error('expected running');
    expect(outcome.skipped).toEqual([]);
    // Flattened, not stripped: two publishers of one model stay two entries.
    expect(outcome.result.models.map((m) => m.suggestedId)).toEqual([
      'google-gemma-4-26b-a4b-qat',
      'lmstudio-community-gemma-4-26b-a4b-qat',
    ]);
    expect(outcome.result.models.map((m) => m.id)).toEqual([
      'google/gemma-4-26b-a4b-qat',
      'lmstudio-community/gemma-4-26b-a4b-qat',
    ]);
  });

  it('reports a runtime whose executable is missing without asking anything over HTTP', async () => {
    const port = await freePort();
    // A live server on the port. Nothing must reach it: without the binary this
    // adapter can neither start nor drive anything, so there is nothing to
    // configure and "not installed" is the answer (§22).
    const server = await startFakeRuntime({ port, model: 'a', healthFlavor: 'mtplx' });
    running.push(server);

    const outcome = await probeAdapter(createMtplxAdapter({ binary: '/definitely/not/a/binary' }), {
      url: `http://127.0.0.1:${port}`,
    });
    expect(outcome.result.status).toBe('not_installed');
    if (outcome.result.status !== 'not_installed') throw new Error('unreachable');
    expect(outcome.result.executable).toBe('/definitely/not/a/binary');
  });

  it('refuses to claim a server that is not its own runtime', async () => {
    const port = await freePort();
    // oMLX and MTPLX default to the same port, so a probe that could not tell
    // them apart would write a configuration aimed at the wrong backend.
    running.push(await startFakeRuntime({ port, multi: true, models: ['a'] }));

    const outcome = await probeAdapter(mtplx(), { url: `http://127.0.0.1:${port}` });
    expect(outcome.result.status).toBe('foreign_server');

    // The same server, probed by the adapter it does belong to.
    const mine = await probeAdapter(omlx(), { url: `http://127.0.0.1:${port}` });
    expect(mine.result.status).toBe('running');
  });

  it('starts a backend it found down, and re-probes where it actually came up', async () => {
    const port = await freePort();
    // The fake `lms` persists its server state between invocations, the same
    // way the real one does.
    process.env.FAKE_LMS_STATE = join(dir.path, 'lms-state.json');
    process.env.FAKE_MODELS = 'a,b';
    const adapter = lmStudio();
    try {
      const down = await probeAdapter(adapter, { url: `http://127.0.0.1:${port}` });
      expect(down.result.status).toBe('not_running');

      const started = await adapter.startServer!({ host: '127.0.0.1', port });
      // Read back, never assumed: LM Studio may honour its own configured port,
      // and re-probing the wrong one would report "not running" about a server
      // that had just started.
      const up = await probeAdapter(adapter, { url: started.url });
      expect(up.result.status).toBe('running');
    } finally {
      // `lms server start` is daemon-style, so the server outlives this test
      // unless it is shut down here. The adapter deliberately refuses `stop`.
      await fetch(`http://127.0.0.1:${port}/__shutdown`).catch(() => {});
      delete process.env.FAKE_LMS_STATE;
      delete process.env.FAKE_MODELS;
    }
  });
});

/**
 * Two runtimes on one adapter (§22) — the shape `keep_resident` forces on a
 * `stop_server` runtime, where the kept model must own its own server.
 *
 * MTPLX's catalogue is installation-wide: `mtplx models` does not know which
 * port asked, so both runtimes report the identical list. Discovery has to take
 * ownership from the configuration rather than from the probe.
 */
describe('two runtimes of one adapter', () => {
  let dir: ReturnType<typeof tempDir>;

  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it('leaves each model on the runtime that already owns it', async () => {
    const path = join(dir.path, 'config.yaml');
    const location = { path, found: true, candidates: [path], source: 'flag' as const };
    writeFileSync(
      path,
      'server: { host: 127.0.0.1, port: 8787 }\n' +
        'runtimes:\n  mtplx: { adapter: mtplx, port: 8000 }\n' +
        '  mtplx_resident: { adapter: mtplx, port: 8001 }\n' +
        'models:\n' +
        '  qwen38:\n    runtime: mtplx\n    backend_model: Vendor/Qwen38\n' +
        '  qwen35-4b:\n    runtime: mtplx_resident\n    backend_model: Vendor/Qwen35-4B\n' +
        '    keep_resident: true\n',
    );

    process.env.FAKE_CATALOGUE = 'Vendor/Qwen38,Vendor/Qwen35-4B';
    const adapter = mtplx();
    const outcomes = [
      await probeAdapter(adapter, { url: 'http://127.0.0.1:8000', runtimeId: 'mtplx' }),
      await probeAdapter(adapter, { url: 'http://127.0.0.1:8001', runtimeId: 'mtplx_resident' }),
    ];
    // Both really did report the same non-empty catalogue; without that this
    // test would pass for the wrong reason.
    // `available` lives only on the outcomes that can carry a catalogue, so it
    // has to be narrowed rather than read off the union.
    const catalogue = (outcome: (typeof outcomes)[number]): string[] => {
      const result = outcome.result;
      if (result.status !== 'running' && result.status !== 'not_running') return [];
      return (result.available ?? []).map((entry) => entry.id);
    };
    expect(catalogue(outcomes[0]!).length).toBeGreaterThan(0);
    expect(catalogue(outcomes[1]!)).toEqual(catalogue(outcomes[0]!));

    const result = saveDiscovery({ outcomes, location });

    expect(result.ambiguous).toEqual([]);
    expect(result.stale).toEqual([]);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('keep_resident: true');
    expect(written).toMatch(/qwen38:\n\s+runtime: mtplx\n/);
    expect(written).toMatch(/qwen35-4b:\n\s+runtime: mtplx_resident\n/);
    delete process.env.FAKE_CATALOGUE;
  });
});
