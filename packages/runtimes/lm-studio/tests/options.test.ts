import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, parseConfig } from '@llm-runtime-dock/core';
import type { ConfigLocation, GatewayError } from '@llm-runtime-dock/core';
import { createLmStudioAdapter } from '../src/index.js';
import { renderLmStudioArgs, validateLmStudioOptions } from '../src/options.js';

/** LM Studio's own options and its two-phase lifecycle contract (spec §19). */

const location = (): ConfigLocation => ({
  path: join(tmpdir(), 'lms.yaml'),
  found: true,
  candidates: [],
  source: 'flag',
});
const adapter = createLmStudioAdapter({ binary: 'lms' });
const load = (yaml: string) => parseConfig(createAdapterRegistry([adapter]), yaml, location());
const context = { id: 'entry', runtimeId: 'rt', entry: {}, runtimeEntry: {} };

describe('lm-studio options', () => {
  it('renders the curated options as documented flags', () => {
    const options = validateLmStudioOptions(
      { gpu: 'max', context_length: 131072, parallel: 4 },
      context,
    );
    expect(renderLmStudioArgs(options)).toEqual([
      '--gpu',
      'max',
      '--context-length',
      '131072',
      '--parallel',
      '4',
    ]);
  });

  it('accepts a gpu ratio as well as off/max', () => {
    expect(renderLmStudioArgs(validateLmStudioOptions({ gpu: 0.5 }, context))).toEqual([
      '--gpu',
      '0.5',
    ]);
    expect(renderLmStudioArgs(validateLmStudioOptions({ gpu: 'off' }, context))).toEqual([
      '--gpu',
      'off',
    ]);
    expect(() => validateLmStudioOptions({ gpu: 2 }, context)).toThrowError(
      expect.objectContaining({ namespace: 'cli' }),
    );
    expect(() => validateLmStudioOptions({ gpu: 'sometimes' }, context)).toThrowError(
      expect.objectContaining({ namespace: 'cli' }),
    );
  });

  it('reserves --ttl, because an idle unload would strand the tracked state', () => {
    const ttl = adapter.reservedArgs.find((r) => r.flags.includes('--ttl'));
    expect(ttl).toBeDefined();
    expect(ttl?.reason).toMatch(/unload|back/i);
    // The identifier is gateway-assigned, so config must not set it.
    expect(adapter.reservedArgs.flatMap((r) => r.flags)).toContain('--identifier');
  });
});

describe('lm-studio adapter', () => {
  it('loads with a gateway-assigned identifier, which is also the served id', () => {
    const config = load(`
runtimes:
  lmstudio: { adapter: lm-studio, port: 1234 }
models:
  local-a:
    runtime: lmstudio
    backend_model: qwen2.5-coder-32b
    options: { context_length: 131072, gpu: max }
`);
    const instance = config.models.get('local-a')!;
    expect(adapter.loadArgs(instance)).toEqual([
      'load',
      'qwen2.5-coder-32b',
      '--identifier',
      'local-a',
      '--gpu',
      'max',
      '--context-length',
      '131072',
      '--yes',
    ]);
    // Identity verification and the upstream request both use the identifier.
    expect(adapter.servedModelId(instance)).toBe('local-a');
  });

  it('frees the slot by unloading, not by stopping the shared server', async () => {
    expect(adapter.modelRelease).toBe('unload_model');

    const config = load(
      'runtimes:\n  lmstudio: { adapter: lm-studio, port: 1234 }\nmodels:\n  a: { runtime: lmstudio, backend_model: m }',
    );
    let thrown: unknown;
    try {
      await adapter.stop(config.models.get('a')!);
    } catch (error) {
      thrown = error;
    }
    // The limitation is represented, not faked: the gateway does not own that server.
    expect((thrown as GatewayError).code).toBe('RUNTIME_STOP_FAILED');
    expect((thrown as GatewayError).message).toContain('lms unload');
  });

  it('reports its endpoint, surfaces and declared context limit', async () => {
    const config = load(
      'runtimes:\n  lmstudio: { adapter: lm-studio, port: 1234 }\nmodels:\n  a: { runtime: lmstudio, backend_model: m, options: { context_length: 8192 } }',
    );
    const instance = config.models.get('a')!;
    expect((await adapter.endpoint(instance)).baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect((await adapter.capabilities(instance)).surfaces).toEqual(['openai', 'anthropic']);
    expect(adapter.declaredLimits(instance)).toEqual({ context: 8192 });
    expect(adapter.defaultProbeTarget).toBe('http://127.0.0.1:1234');
  });
});

describe('what a probe asks for LM Studio', () => {
  it('asks for a credential, since a probe here can come back auth_required', () => {
    expect(adapter.probeQuestions.map((question) => question.key)).toContain('api_key_env');
  });
});
