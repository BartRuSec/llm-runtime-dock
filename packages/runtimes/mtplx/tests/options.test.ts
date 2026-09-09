import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAdapterRegistry,
  parseConfig,
  renderDiscoveredModels,
  validateBackendModelRef,
  validateDiscoveredId,
} from '@llm-runtime-dock/core';
import type { CliError } from '@llm-runtime-dock/core';
import type { AdapterProbeOutcome, ConfigLocation, ProcessExecutor } from '@llm-runtime-dock/core';
import { createMtplxAdapter, suggestLogicalId } from '../src/index.js';
import {
  MTPLX_DEFAULT_OPTIONS,
  MTPLX_OPTION_SPECS,
  renderMtplxArgs,
  validateMtplxOptions,
} from '../src/options.js';

/**
 * MTPLX's own launch options and argv (spec §18). The reserved-argument
 * *mechanism* is core's and is tested there; what belongs here is which flags
 * this runtime owns and how its options render.
 */

const location = (): ConfigLocation => ({
  path: join(tmpdir(), 'mtplx.yaml'),
  found: true,
  candidates: [],
  source: 'flag',
});

/**
 * Two declared runtimes, prepended to every fixture below: the endpoint is not
 * what these tests are about, and repeating it in each one would only obscure
 * the option they do test.
 */
const RUNTIMES =
  'runtimes:\n  mtplx: { adapter: mtplx, port: 8000 }\n  other: { adapter: mtplx, port: 8001 }\n';

const load = (yaml: string) =>
  parseConfig(
    createAdapterRegistry([createMtplxAdapter({ binary: 'mtplx' })]),
    yaml.includes('runtimes:') ? yaml : `${RUNTIMES}${yaml}`,
    location(),
  );

const context = { id: 'entry', runtimeId: 'rt', entry: {}, runtimeEntry: {} };

describe('mtplx options', () => {
  it('accepts every curated option and maps it to a documented flag', () => {
    const options = validateMtplxOptions(
      {
        reasoning: 'on',
        reasoning_effort: 'high',
        profile: 'turbo',
        depth: 3,
        generation_mode: 'mtp',
        context_window: 131072,
        max_tokens: 32768,
        batching_preset: 'agent',
        scheduler_mode: 'greedy',
        tool_prompt_mode: 'native',
        chat_template_profile: 'tokenizer',
        chat_template_path: '/tmp/chat_template.jinja',
        reasoning_parser: 'qwen3',
        preserve_thinking: 'scoped',
        agent_rewrites: 'off',
        stats_footer: true,
        stream_interval: 4,
      },
      context,
    );
    expect(renderMtplxArgs(options)).toEqual([
      '--reasoning',
      'on',
      '--reasoning-effort',
      'high',
      '--profile',
      'turbo',
      '--depth',
      '3',
      '--generation-mode',
      'mtp',
      '--context-window',
      '131072',
      '--max-tokens',
      '32768',
      '--batching-preset',
      'agent',
      '--scheduler-mode',
      'greedy',
      '--tool-prompt-mode',
      'native',
      '--chat-template-profile',
      'tokenizer',
      '--chat-template-path',
      '/tmp/chat_template.jinja',
      '--reasoning-parser',
      'qwen3',
      '--preserve-thinking',
      'scoped',
      '--agent-rewrites',
      'off',
      '--stream-interval',
      '4',
    ]);
  });

  it('omits an option that was not set, but still applies the launch defaults', () => {
    expect(renderMtplxArgs(validateMtplxOptions({ profile: 'exact' }, context))).toEqual([
      '--profile',
      'exact',
      '--no-stats-footer',
    ]);
    expect(renderMtplxArgs(validateMtplxOptions({}, context))).toEqual(['--no-stats-footer']);
  });

  it('defaults only to flags whose correct value cannot depend on the model', () => {
    // The selection rule for the table (§18). A model-dependent default would
    // be written without knowing which `backend_model` the entry names, so the
    // table may hold nothing that MTPLX resolves per model — which is why it
    // carries no tool-calling flag at all.
    expect(Object.keys(MTPLX_DEFAULT_OPTIONS)).toEqual(['stats_footer']);
    for (const modelDependent of [
      'tool_prompt_mode',
      'chat_template_profile',
      'chat_template_path',
      'reasoning_parser',
      'preserve_thinking',
      'reasoning',
      'reasoning_effort',
      'profile',
      'depth',
      'generation_mode',
      'context_window',
      'max_tokens',
    ]) {
      expect(MTPLX_DEFAULT_OPTIONS).not.toHaveProperty(modelDependent);
    }
  });

  it('lets an entry override a default, and opt out of the table entirely', () => {
    // `--no-stats-footer` is the only spelling MTPLX has, so `true` means
    // "render nothing and let MTPLX keep appending its footer".
    expect(renderMtplxArgs(validateMtplxOptions({ stats_footer: true }, context))).toEqual([]);
    expect(renderMtplxArgs(validateMtplxOptions({ defaults: false }, context))).toEqual([]);
    // Opting out drops the defaults, never the entry's own options.
    expect(
      renderMtplxArgs(validateMtplxOptions({ defaults: false, profile: 'turbo' }, context)),
    ).toEqual(['--profile', 'turbo']);
  });

  it('expands a chat template path without changing what config recorded', () => {
    const options = validateMtplxOptions({ chat_template_path: '~/templates/qwen.jinja' }, context);
    // The validated value stays verbatim; expansion happens at render time.
    expect(options.chat_template_path).toBe('~/templates/qwen.jinja');
    const rendered = renderMtplxArgs(options);
    const path = rendered[rendered.indexOf('--chat-template-path') + 1] ?? '';
    expect(path.startsWith('~')).toBe(false);
    expect(path.endsWith('templates/qwen.jinja')).toBe(true);
  });

  it('rejects a value outside a documented enum', () => {
    for (const bad of [
      { profile: 'nope' },
      { reasoning: 'maybe' },
      { generation_mode: 'x' },
      { tool_prompt_mode: 'compact' },
      { chat_template_profile: 'qwen' },
      { reasoning_parser: 'llama' },
      { preserve_thinking: 'always' },
      { agent_rewrites: 'maybe' },
      { stream_interval: 0 },
      { stats_footer: 'yes' },
    ]) {
      expect(() => validateMtplxOptions(bad, context)).toThrowError(
        expect.objectContaining({ namespace: 'cli' }),
      );
    }
  });

  it('rejects a boolean where an enum is declared, and says to quote it', () => {
    // YAML parsers that read `on:` as a boolean would otherwise pass a bool here.
    try {
      validateMtplxOptions({ reasoning: true }, context);
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as CliError).code).toBe('RUNTIME_OPTIONS_INVALID');
      expect((error as CliError).hint).toContain('quote');
    }
  });

  it('declares the arguments the gateway owns', () => {
    const adapter = createMtplxAdapter({ binary: 'mtplx' });
    const flags = adapter.reservedArgs.flatMap((r) => r.flags);
    for (const flag of [
      '--host',
      '--port',
      '--model',
      '--model-id',
      '--api-key',
      '--api-key-file',
    ]) {
      expect(flags).toContain(flag);
    }
    // Every reserved entry must name a remedy, or the error is not actionable.
    for (const reserved of adapter.reservedArgs) {
      expect(reserved.insteadUse).toBeTruthy();
      expect(reserved.reason).toBeTruthy();
    }
  });

  it('curates a documented flag for every named option', () => {
    for (const [key, spec] of Object.entries(MTPLX_OPTION_SPECS)) {
      // The one exception is a key that renders no flag of its own; it has to
      // say so, or the extra_args collision check would treat its label as a
      // flag this adapter owns.
      expect(spec.rendersNoFlag === true || spec.flag.startsWith('-')).toBe(true);
      expect(key).not.toContain('-');
    }
  });
});

/** Canned `mtplx models --json`, so the cache can be exercised without one. */
const executorReturning = (stdout: string): ProcessExecutor => ({
  run: async () => ({ code: 0, signal: null, stdout, stderr: '' }),
  spawn: () => {
    throw new Error('not used');
  },
  which: async () => true,
});

describe('mtplx adapter', () => {
  const adapter = createMtplxAdapter({ binary: 'mtplx' });

  it('marks a cached model without a valid runtime contract as unusable', async () => {
    // MTPLX validates its own cache; `ok: false` means it cannot serve the model.
    const probing = createMtplxAdapter({
      binary: 'mtplx',
      executor: executorReturning(
        JSON.stringify({
          models: [
            { repo_id: 'Vendor/Good-MTPLX', validation: { ok: true } },
            { repo_id: 'vendor/no-contract', validation: { ok: false } },
          ],
        }),
      ),
    });

    // Nothing listening, so the answer is "not running" plus the local cache.
    const result = await probing.probe({ url: 'http://127.0.0.1:1', timeoutMs: 200 });
    expect(result.status).toBe('not_running');
    const available = result.status === 'not_running' ? (result.available ?? []) : [];
    expect(available.map((m) => [m.id, m.unusable])).toEqual([
      ['Vendor/Good-MTPLX', undefined],
      ['vendor/no-contract', 'MTPLX reports no valid runtime contract for this model'],
    ]);
  });

  it('builds the serve argv from configuration only', () => {
    const config = load(`
models:
  quality:
    runtime: mtplx
    backend_model: Qwen3.8-27B
    options: { reasoning: "on", context_window: 131072, max_tokens: 32768 }
    extra_args: [--batching-preset, agent]
`);
    expect(adapter.serveArgs(config.models.get('quality')!)).toEqual([
      'serve',
      '--model',
      'Qwen3.8-27B',
      '--host',
      '127.0.0.1',
      '--port',
      '8000',
      '--reasoning',
      'on',
      '--context-window',
      '131072',
      '--max-tokens',
      '32768',
      '--no-stats-footer',
      '--batching-preset',
      'agent',
    ]);
  });

  it('renders every curated flag before extra_args, so the escape hatch wins', () => {
    const config = load(`
models:
  quality:
    runtime: mtplx
    backend_model: Qwen3.8-27B
    options: { tool_prompt_mode: native, stats_footer: true }
    extra_args: [--chat-template-profile, tokenizer]
`);
    const args = adapter.serveArgs(config.models.get('quality')!);
    // Precedence between a launch default and an entry option is by value, not
    // by position: they merge into one option set which renders in a fixed flag
    // order. Here the entry set `stats_footer: true`, so the default is gone.
    expect(args).not.toContain('--no-stats-footer');
    // Position is what decides against extra_args, and MTPLX takes the last
    // spelling of a repeated flag, so extra_args has to come last.
    expect(args.indexOf('--tool-prompt-mode')).toBeLessThan(
      args.indexOf('--chat-template-profile'),
    );
    expect(args.at(-2)).toBe('--chat-template-profile');
    expect(args.at(-1)).toBe('tokenizer');
  });

  it('produces different argv for two entries sharing a backend model', () => {
    const config = load(`
models:
  turbo: { runtime: mtplx, backend_model: Same, options: { profile: turbo } }
  exact: { runtime: mtplx, backend_model: Same, options: { profile: exact } }
`);
    const turbo = adapter.serveArgs(config.models.get('turbo')!);
    const exact = adapter.serveArgs(config.models.get('exact')!);
    expect(turbo).not.toEqual(exact);
    // Identity verification would pass for both, which is why the scheduler
    // compares entry ids rather than model names (§9).
    expect(adapter.servedModelId(config.models.get('turbo')!)).toBe('Same');
    expect(adapter.servedModelId(config.models.get('exact')!)).toBe('Same');
  });

  it('frees the slot by stopping the server, and serves both surfaces', async () => {
    const config = load('models:\n  a: { runtime: mtplx, backend_model: M }');
    const instance = config.models.get('a')!;
    expect(adapter.modelRelease).toBe('stop_server');
    expect((await adapter.capabilities(instance)).surfaces).toEqual(['openai', 'anthropic']);
    expect((await adapter.endpoint(instance)).baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(adapter.defaultProbeTarget).toBe('http://127.0.0.1:8000');
  });

  it('states the limits its launch options declare, and nothing more', () => {
    const config = load(`
models:
  known: { runtime: mtplx, backend_model: M, options: { context_window: 4096, max_tokens: 512 } }
  unknown: { runtime: other, backend_model: M }
`);
    expect(adapter.declaredLimits(config.models.get('known')!)).toEqual({
      context: 4096,
      output: 512,
    });
    // A limit the adapter cannot state is omitted rather than guessed.
    expect(adapter.declaredLimits(config.models.get('unknown')!)).toEqual({
      context: undefined,
      output: undefined,
    });
  });

  it('names the executable it would run, for doctor', () => {
    const config = load('models:\n  a: { runtime: mtplx, backend_model: M }');
    expect(adapter.requiredExecutables?.(config.models.get('a')!)).toEqual(['mtplx']);
  });
});

describe('discovery round trip', () => {
  const adapter = createMtplxAdapter({ binary: 'mtplx' });

  it('suggests a readable key without touching the backend reference', () => {
    // The key is only a name for a human to review; the id MTPLX actually
    // serves under is learned from /v1/models, never derived from this.
    expect(suggestLogicalId('Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality')).toBe(
      'qwen3.8-27b-mtplx-optimized-quality',
    );
    expect(suggestLogicalId('pyros-vault/Ornith-1.5-35B-A3B-oQ6e-fixed-mtp')).toBe(
      'ornith-1.5-35b-a3b-oq6e-fixed-mtp',
    );
    expect(suggestLogicalId('plain-name')).toBe('plain-name');
  });

  it('produces keys a config accepts and refs a launch command accepts', () => {
    for (const repoId of [
      'Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality',
      'ornith-ai/Ornith-1.5-35B-A3B',
      'pyros-vault/Ornith-1.5-35B-A3B-oQ6e-fixed-mtp',
    ]) {
      // A repo id is a fine `backend_model` but not a fine YAML key, which is
      // why discovery carries the two separately.
      expect(validateBackendModelRef(repoId).ok).toBe(true);
      expect(validateDiscoveredId(repoId).ok).toBe(false);
      expect(validateDiscoveredId(suggestLogicalId(repoId)).ok).toBe(true);
    }
  });

  it('writes configuration that starts the model it discovered', () => {
    // The round trip that was broken: what `probe --save` writes has to be what
    // `mtplx serve --model` can actually load.
    const repoId = 'Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality';
    const outcome: AdapterProbeOutcome = {
      adapter: 'mtplx',
      runtimeId: 'mtplx',
      result: {
        status: 'not_running',
        url: 'http://127.0.0.1:8000',
        available: [{ id: repoId, suggestedId: suggestLogicalId(repoId) }],
      },
      skipped: [],
    };

    const preview = renderDiscoveredModels([outcome]);
    expect(preview?.ids).toEqual(['qwen3.8-27b-mtplx-optimized-quality']);

    const config = parseConfig(createAdapterRegistry([adapter]), preview!.yaml, location());
    const instance = config.models.get('qwen3.8-27b-mtplx-optimized-quality')!;
    expect(instance.backendModel).toBe(repoId);
    expect(adapter.serveArgs(instance)).toContain(repoId);
  });
});

describe('served model identity', () => {
  const adapter = createMtplxAdapter({ binary: 'mtplx' });

  /** A minimal stand-in for MTPLX's /v1/models, to drive verifyIdentity. */
  const servingModels = async (
    ids: string[],
  ): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
      port: typeof address === 'object' && address ? address.port : 0,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  const entryFor = (port: number) =>
    load(
      `runtimes:\n  mtplx: { adapter: mtplx, port: ${port} }\nmodels:\n  quality: { runtime: mtplx, backend_model: Vendor/Some-Model-27B }`,
    ).models.get('quality')!;

  it('records the id the server reports, which is not the configured reference', async () => {
    // MTPLX derives the served id from the loaded artifact; `--model-id` is
    // reserved so it cannot drift, and the gateway learns it rather than
    // guessing a slug from the repo id.
    const server = await servingModels(['mtplx-some-model-27b']);
    try {
      const instance = entryFor(server.port);
      const check = await adapter.verifyIdentity(instance);
      expect(check.ok).toBe(true);
      expect(adapter.servedModelId(instance)).toBe('mtplx-some-model-27b');
    } finally {
      await server.close();
    }
  });

  it('rejects a server that is running but has nothing loaded', async () => {
    const server = await servingModels([]);
    try {
      const check = await adapter.verifyIdentity(entryFor(server.port));
      expect(check.ok).toBe(false);
      expect(check.detail).toContain('no model loaded');
    } finally {
      await server.close();
    }
  });

  it('rejects a server reporting more than one model, since it serves one', async () => {
    const server = await servingModels(['a', 'b']);
    try {
      const check = await adapter.verifyIdentity(entryFor(server.port));
      expect(check.ok).toBe(false);
      expect(check.served).toEqual(['a', 'b']);
    } finally {
      await server.close();
    }
  });

  it('forgets the served id on release, so a later start is not proxied under it', async () => {
    const server = await servingModels(['mtplx-some-model-27b']);
    const instance = entryFor(server.port);
    try {
      await adapter.verifyIdentity(instance);
      expect(adapter.servedModelId(instance)).toBe('mtplx-some-model-27b');
    } finally {
      await server.close();
    }
    // With the server gone, release still clears the cache.
    await adapter.release(instance).catch(() => {});
    expect(adapter.servedModelId(instance)).toBe('Vendor/Some-Model-27B');
  });
});

describe('what a probe asks for MTPLX', () => {
  const adapter = createMtplxAdapter({ binary: 'mtplx' });

  it('asks for a credential, because MTPLX can be told to require one', () => {
    // `mtplx serve --api-key` / `--api-key-file`, and /health reports
    // `api_key_required`. Both flags are reserved here (§12), so the `auth:`
    // block on the runtime is the way in — which is what this question fills.
    expect(adapter.probeQuestions.map((question) => question.key)).toContain('api_key_env');
    expect(adapter.reservedArgs.some((arg) => arg.flags.includes('--api-key'))).toBe(true);
  });
});
