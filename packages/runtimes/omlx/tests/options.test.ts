import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, parseConfig } from '@llm-runtime-dock/core';
import type { ConfigLocation } from '@llm-runtime-dock/core';
import { createOmlxAdapter } from '../src/index.js';
import {
  OMLX_SERVER_SCOPED_OPTION_KEYS,
  renderOmlxArgs,
  validateOmlxOptions,
} from '../src/options.js';

/** oMLX's spawn-mode options, which are server-scoped rather than per-model (spec §20). */

const location = (): ConfigLocation => ({
  path: join(tmpdir(), 'omlx.yaml'),
  found: true,
  candidates: [],
  source: 'flag',
});
const adapter = createOmlxAdapter({ binary: 'omlx' });
const load = (yaml: string) => parseConfig(createAdapterRegistry([adapter]), yaml, location());
const context = { id: 'entry', runtimeId: 'rt', entry: {}, runtimeEntry: {} };

describe('omlx options', () => {
  it('renders the documented server flags', () => {
    const options = validateOmlxOptions(
      { model_dir: '/models', memory_guard: 'balanced', max_concurrent_requests: 4 },
      context,
    );
    expect(renderOmlxArgs(options)).toEqual([
      '--model-dir',
      '/models',
      '--memory-guard',
      'balanced',
      '--max-concurrent-requests',
      '4',
    ]);
  });

  it('rejects an undocumented memory guard', () => {
    expect(() => validateOmlxOptions({ memory_guard: 'paranoid' }, context)).toThrowError(
      expect.objectContaining({ namespace: 'cli' }),
    );
  });

  it('declares every option as server-scoped, because entries share one server', () => {
    // In attach mode there are no per-entry options at all; everything about how
    // a model runs lives in oMLX's own configuration.
    expect([...OMLX_SERVER_SCOPED_OPTION_KEYS].sort()).toEqual([
      'max_concurrent_requests',
      'memory_guard',
      'model_dir',
    ]);
    expect([...adapter.serverScopedOptionKeys].sort()).toEqual(
      [...OMLX_SERVER_SCOPED_OPTION_KEYS].sort(),
    );
  });
});

describe('omlx adapter', () => {
  it('spawns with omlx serve, which accepts host and port', () => {
    const config = load(
      'runtimes:\n  omlx: { adapter: omlx, port: 5678, options: { model_dir: /models } }\nmodels:\n  m: { runtime: omlx, backend_model: coder-35b }',
    );
    // `omlx start/stop/restart` drive the app's own server and take their
    // endpoint from oMLX settings; the gateway must own its endpoint.
    expect(adapter.serveArgs(config.models.get('m')!)).toEqual([
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '5678',
      '--model-dir',
      '/models',
    ]);
  });

  it('frees the slot by unloading, leaving the server up', async () => {
    expect(adapter.modelRelease).toBe('unload_model');
    const config = load(
      'runtimes:\n  omlx: { adapter: omlx, port: 5678 }\nmodels:\n  m: { runtime: omlx, backend_model: coder-35b }',
    );
    const instance = config.models.get('m')!;
    expect(adapter.servedModelId(instance)).toBe('coder-35b');
    expect((await adapter.endpoint(instance)).baseUrl).toBe('http://127.0.0.1:5678/v1');
    expect((await adapter.capabilities(instance)).surfaces).toEqual(['openai', 'anthropic']);
    // One constant per package, read by both the probe target and the
    // `runtime.port ?? DEFAULT_PORT` fallback, so the two cannot drift apart.
    // 8000 is a stock oMLX install, and MTPLX defaults there too — which is why
    // `probe` asks a server whether it is oMLX before claiming it (§22).
    expect(adapter.defaultProbeTarget).toBe('http://127.0.0.1:8000');
  });

  it('lets two entries share one endpoint when their server options agree', () => {
    expect(() =>
      load(`
runtimes:
  omlx: { adapter: omlx, port: 5678, options: { memory_guard: safe } }
models:
  coder: { runtime: omlx, backend_model: coder-35b }
  small: { runtime: omlx, backend_model: llama-3b }
`),
    ).not.toThrow();
  });
});

describe('starting oMLX from a probe', () => {
  it('offers the question and implements the member behind it', () => {
    // The two have to move together: a question nothing implements is a prompt
    // that leads to a refusal (§22).
    expect(adapter.probeQuestions.some((question) => question.key === 'start')).toBe(true);
    expect(typeof adapter.startServer).toBe('function');
  });

  it('reports the endpoint it was asked about, since omlx start takes no port', () => {
    // `omlx start` brings the managed server up on whatever oMLX's own settings
    // say, and this adapter must not read that file (§10) — so there is nothing
    // to read the port back from, and the answer is checked instead.
    const started = adapter.probeQuestions.find((question) => question.key === 'start');
    expect(started?.type).toBe('confirm');
    expect(started?.default).toBe(false);
  });
});
