import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, parseConfig } from '@llm-runtime-dock/core';
import type { ConfigLocation } from '@llm-runtime-dock/core';
import { createOllamaAdapter, DEFAULT_PORT } from '../src/index.js';
import {
  OLLAMA_SERVER_SCOPED_OPTION_KEYS,
  renderOllamaEnv,
  validateOllamaOptions,
} from '../src/options.js';

const location = (): ConfigLocation => ({
  path: join(tmpdir(), 'ollama.yaml'),
  found: true,
  candidates: [],
  source: 'flag',
});
const context = { id: 'entry', runtimeId: 'rt', entry: {}, runtimeEntry: {} };
const adapter = createOllamaAdapter({ binary: 'ollama' });
const load = (yaml: string) => parseConfig(createAdapterRegistry([adapter]), yaml, location());

describe('ollama options', () => {
  it('renders documented environment variables and expands model_dir', () => {
    expect(
      renderOllamaEnv(
        validateOllamaOptions(
          {
            model_dir: '~/models',
            context_length: 8192,
            max_loaded_models: 2,
            num_parallel: 4,
            flash_attention: true,
            kv_cache_type: 'q8_0',
          },
          context,
        ),
      ),
    ).toMatchObject({
      OLLAMA_CONTEXT_LENGTH: '8192',
      OLLAMA_MAX_LOADED_MODELS: '2',
      OLLAMA_NUM_PARALLEL: '4',
      OLLAMA_FLASH_ATTENTION: 'true',
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
    });
  });

  it('rejects undocumented options and unsafe residency limits', () => {
    expect(() => validateOllamaOptions({ unknown: true }, context)).toThrowError(
      expect.objectContaining({ namespace: 'cli' }),
    );
    expect(() =>
      validateOllamaOptions(
        { max_loaded_models: 1 },
        { ...context, entry: { keep_resident: true } },
      ),
    ).toThrowError(expect.objectContaining({ namespace: 'cli' }));
  });

  it('refuses extra_args, because `ollama serve` takes no flags', () => {
    // The escape hatch reaches nothing here: `ollama serve` accepts only `-h`,
    // so an argument put there would be handed to it as an operand. Caught at
    // load time rather than at the first switch.
    expect(() =>
      load(
        [
          'runtimes:',
          '  ollama: { adapter: ollama, port: 11434 }',
          'models:',
          '  llama:',
          '    runtime: ollama',
          '    backend_model: llama3.2',
          '    extra_args: ["--verbose"]',
        ].join('\n'),
      ),
    ).toThrowError(/extra_args is not supported/);
    // An empty list is not a mistake, and neither is omitting it.
    expect(() =>
      load(
        [
          'runtimes:',
          '  ollama: { adapter: ollama, port: 11434 }',
          'models:',
          '  llama: { runtime: ollama, backend_model: llama3.2, extra_args: [] }',
        ].join('\n'),
      ),
    ).not.toThrow();
  });

  it('keeps all options server-scoped and does not offer probe start', () => {
    expect([...adapter.serverScopedOptionKeys].sort()).toEqual(
      [...OLLAMA_SERVER_SCOPED_OPTION_KEYS].sort(),
    );
    expect(adapter.probeQuestions.some((question) => question.key === 'start')).toBe(false);
    expect(adapter.startServer).toBeUndefined();
  });

  it('pins one DEFAULT_PORT to both the probe target and the port fallback', async () => {
    // One constant per package, read by both `defaultProbeTarget` and the
    // `runtime.port ?? DEFAULT_PORT` fallback, so the two cannot drift apart:
    // splitting them gives a probe that finds a server the gateway then fails
    // to reach. 11434 is a stock Ollama install.
    expect(DEFAULT_PORT).toBe(11434);
    expect(adapter.defaultProbeTarget).toBe(`http://127.0.0.1:${DEFAULT_PORT}`);
    const config = load(
      'runtimes:\n  ollama: { adapter: ollama }\nmodels:\n  llama: { runtime: ollama, backend_model: llama3.2 }',
    );
    const instance = config.models.get('llama')!;
    expect(instance.port).toBeUndefined();
    expect((await adapter.endpoint(instance)).baseUrl).toBe(`http://127.0.0.1:${DEFAULT_PORT}/v1`);
  });

  it('frees the slot by unloading, and serves the OpenAI surface only', async () => {
    expect(adapter.modelRelease).toBe('unload_model');
    const config = load(
      'runtimes:\n  ollama: { adapter: ollama, port: 5678 }\nmodels:\n  llama: { runtime: ollama, backend_model: llama3.2 }',
    );
    const instance = config.models.get('llama')!;
    // `tagged` is for comparing against `/api/ps`, never for addressing the
    // server: the configured spelling is what the upstream answers to (§13).
    expect(adapter.servedModelId(instance)).toBe('llama3.2');
    expect((await adapter.capabilities(instance)).surfaces).toEqual(['openai']);
  });

  it('round-trips two entries sharing one Ollama server', () => {
    const config = load(
      'runtimes:\n  ollama: { adapter: ollama, port: 11434, options: { max_loaded_models: 2 } }\nmodels:\n  llama: { runtime: ollama, backend_model: llama3.2 }\n  coder: { runtime: ollama, backend_model: qwen2.5-coder:7b }',
    );
    expect(config.models.get('coder')?.backendModel).toBe('qwen2.5-coder:7b');
  });
});
