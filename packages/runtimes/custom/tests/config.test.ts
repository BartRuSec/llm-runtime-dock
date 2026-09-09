import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, parseConfig } from '@llm-runtime-dock/core';
import type { ConfigLocation } from '@llm-runtime-dock/core';
import { checkUrlAgreement, createCustomAdapter } from '../src/index.js';
import type { CustomEntry } from '../src/config.js';

/**
 * The custom adapter (spec §11).
 *
 * SECURITY: the command is an argv array used verbatim. Nothing derived from an
 * HTTP request may reach it, and the shell is opt-in only.
 */

const location = (): ConfigLocation => ({
  path: join(tmpdir(), 'custom.yaml'),
  found: true,
  candidates: [],
  source: 'flag',
});
const adapter = createCustomAdapter();
const load = (yaml: string) => parseConfig(createAdapterRegistry([adapter]), yaml, location());

const entry = (extra = '') => `
runtimes:
  legacy:
    adapter: custom
    process:
      start: { command: [some-runtime, serve, --port, "8100"] }
      stop: { command: [some-runtime, stop] }
    health: { url: "http://127.0.0.1:8100/health" }
    model_discovery: { url: "http://127.0.0.1:8100/v1/models" }
    endpoint: { url: "http://127.0.0.1:8100/v1" }${extra}
models:
  legacy: { runtime: legacy, backend_model: some-model-7b }
`;

describe('custom entry validation', () => {
  it('requires the process and URL blocks it has no defaults for', () => {
    expect(() =>
      load('runtimes:\n  x: { adapter: custom }\nmodels:\n  x: { runtime: x, backend_model: m }'),
    ).toThrowError(expect.objectContaining({ namespace: 'cli' }));
    expect(() => load(entry())).not.toThrow();
  });

  it('rejects options, which this adapter does not use', () => {
    // Everything runtime-specific belongs in process.start.command instead.
    expect(() =>
      load(entry().replace('    health:', '    options: { gpu: max }\n    health:')),
    ).toThrowError(expect.objectContaining({ namespace: 'cli' }));
  });

  it('keeps the whole argv exactly as written, with the shell off', () => {
    const config = load(`
runtimes:
  legacy:
    adapter: custom
    process:
      start: { command: ["my-runtime", "serve", "--flag", "a b; c && d"] }
    health: { url: "http://127.0.0.1:8100/health" }
    model_discovery: { url: "http://127.0.0.1:8100/v1/models" }
    endpoint: { url: "http://127.0.0.1:8100/v1" }
models:
  legacy: { runtime: legacy, backend_model: m }
`);
    const parsed = config.models.get('legacy')!.options as CustomEntry;
    // The metacharacters stay inside one argument and are never split or interpreted.
    expect(parsed.process.start.command).toEqual(['my-runtime', 'serve', '--flag', 'a b; c && d']);
    expect(parsed.process.start.shell).toBeUndefined();
  });

  it('accepts shell execution only when configuration opts in explicitly', () => {
    const config = load(`
runtimes:
  legacy:
    adapter: custom
    process:
      start: { command: ["my-runtime serve | tee log"], shell: true }
    health: { url: "http://127.0.0.1:8100/health" }
    model_discovery: { url: "http://127.0.0.1:8100/v1/models" }
    endpoint: { url: "http://127.0.0.1:8100/v1" }
models:
  legacy: { runtime: legacy, backend_model: m }
`);
    expect((config.models.get('legacy')!.options as CustomEntry).process.start.shell).toBe(true);
  });

  it('exempts the user-owned argv from the reserved-argument rules', () => {
    // §11: the user owns the whole command here, so --port in it is not reserved.
    expect(adapter.reservedArgs).toEqual([]);
    expect(() => load(entry())).not.toThrow();
  });
});

describe('custom adapter surfaces and endpoints', () => {
  it('declares OpenAI only unless the entry opts in', async () => {
    const openaiOnly = load(entry()).models.get('legacy')!;
    // Nothing about a user-defined command implies an Anthropic endpoint.
    expect((await adapter.capabilities(openaiOnly)).surfaces).toEqual(['openai']);

    const both = load(entry('\n    surfaces: [openai, anthropic]')).models.get('legacy')!;
    expect((await adapter.capabilities(both)).surfaces).toEqual(['openai', 'anthropic']);
  });

  it('uses the declared endpoint and frees the slot by stopping the server', async () => {
    const instance = load(entry()).models.get('legacy')!;
    expect(adapter.modelRelease).toBe('stop_server');
    expect((await adapter.endpoint(instance)).baseUrl).toBe('http://127.0.0.1:8100/v1');
    // Discovery has no conventional port to guess for a user-defined runtime.
    expect(adapter.defaultProbeTarget).toBeNull();
  });

  it('names both configured executables for doctor', () => {
    expect(adapter.requiredExecutables?.(load(entry()).models.get('legacy')!)).toEqual([
      'some-runtime',
      'some-runtime',
    ]);
  });
});

describe('doctor checks that the command and the declared URLs agree', () => {
  const base = (): CustomEntry => load(entry()).models.get('legacy')!.options as CustomEntry;

  it('is satisfied when they match', () => {
    expect(checkUrlAgreement(base())).toEqual([]);
  });

  it('reports a port in the command that the endpoint contradicts', () => {
    const mismatched = base();
    mismatched.process.start.command = ['some-runtime', 'serve', '--port', '9999'];
    const warnings = checkUrlAgreement(mismatched);
    expect(warnings.join(' ')).toContain('9999');
  });

  it('reports health, discovery and endpoint pointing at different origins', () => {
    const split = base();
    split.health = { url: 'http://127.0.0.1:7000/health' };
    expect(checkUrlAgreement(split).join(' ')).toContain('different origins');
  });
});
