import { describe, expect, it } from 'vitest';
import {
  createLogger,
  listLogicalModels,
  normalizeModelId,
  parseConfig,
  resolveModel,
  rewriteModelField,
} from '../src/index.js';
import { createAdapterRegistry } from '../src/index.js';
import { createStubAdapter, testLocation } from './helpers/stubs.js';

/** Model resolution (§13) and the one request field the gateway touches (§12). */

const config = parseConfig(
  createAdapterRegistry([createStubAdapter()]),
  `
runtimes:
  a: { adapter: stub, port: 8000 }
  b: { adapter: stub, port: 8001 }
models:
  coding-quality: { runtime: a, backend_model: Some-Model-27B }
  coding-fast: { runtime: b, backend_model: Some-Model-8B }
  embeddings: { runtime: b, backend_model: Some-Embed-Model, disabled: true }
`,
  testLocation(),
);

describe('model resolution', () => {
  it('resolves a logical id to its runtime instance', () => {
    expect(resolveModel(config, 'coding-quality').backendModel).toBe('Some-Model-27B');
  });

  it('accepts the namespaced spelling', () => {
    expect(normalizeModelId('llm-runtime-dock/coding-fast')).toBe('coding-fast');
    expect(resolveModel(config, 'llm-runtime-dock/coding-fast').id).toBe('coding-fast');
  });

  it('fails an unknown id with MODEL_NOT_FOUND and lists what is configured', () => {
    try {
      resolveModel(config, 'nope');
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as { code: string }).code).toBe('MODEL_NOT_FOUND');
      expect((error as { hint?: string }).hint).toContain('coding-quality');
    }
  });

  it('fails a missing or non-string model field', () => {
    for (const value of [undefined, null, 42, '', '   ']) {
      expect(() => resolveModel(config, value)).toThrowError();
    }
  });

  it('refuses a disabled entry, saying so rather than calling it unknown', () => {
    // The one gate the flag is enforced at (§12): everything past this point —
    // the scheduler included — is only reachable through resolution.
    try {
      resolveModel(config, 'embeddings');
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as { code: string }).code).toBe('MODEL_NOT_FOUND');
      expect((error as Error).message).toContain('disabled');
      expect((error as { hint?: string }).hint).toContain('models.embeddings');
      // Never offered back as something to try instead.
      expect((error as { details: { known: string[] } }).details.known).not.toContain('embeddings');
    }
  });

  it('leaves a disabled id out of the ids an unknown model is compared against', () => {
    try {
      resolveModel(config, 'nope');
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as { details: { known: string[] } }).details.known).toEqual([
        'coding-quality',
        'coding-fast',
      ]);
    }
  });

  it('advertises the configured logical ids, loaded or not, except disabled ones', () => {
    const listed = listLogicalModels(config);
    expect(listed.object).toBe('list');
    expect(listed.data.map((m) => m.id)).toEqual(['coding-quality', 'coding-fast']);
    // The backend model name is never exposed to the client.
    expect(JSON.stringify(listed)).not.toContain('Some-Model-27B');
    expect(listed.data[0]?.owned_by).toBe('llm-runtime-dock');
  });
});

describe('request body rewriting', () => {
  it('replaces exactly the model field and nothing else', () => {
    const body = JSON.stringify({
      model: 'coding-quality',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.2,
      tools: [{ type: 'function' }],
      stream: true,
    });
    const out = JSON.parse(rewriteModelField(body, 'Some-Model-27B')) as Record<string, unknown>;

    expect(out.model).toBe('Some-Model-27B');
    // No inference defaults injected, nothing dropped (§12).
    expect(Object.keys(out).sort()).toEqual([
      'messages',
      'model',
      'stream',
      'temperature',
      'tools',
    ]);
    expect(out.temperature).toBe(0.2);
    expect(out.messages).toEqual([{ role: 'user', content: 'x' }]);
  });

  it('leaves a body it cannot or should not touch alone', () => {
    expect(rewriteModelField('{"messages":[]}', 'x')).toBe('{"messages":[]}');
    expect(rewriteModelField('not json', 'x')).toBe('not json');
    expect(rewriteModelField('', 'x')).toBe('');
    expect(rewriteModelField('[1,2]', 'x')).toBe('[1,2]');
    expect(rewriteModelField('null', 'x')).toBe('null');
  });
});

describe('logging', () => {
  it('never writes a credential', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', format: 'json', write: (l) => lines.push(l) });
    log.info('upstream call', {
      authorization: 'Bearer super-secret',
      api_key: 'sk-12345',
      token: 'tok_abc',
      runtime: 'coding-quality',
    });
    const line = lines.join('');
    expect(line).not.toContain('super-secret');
    expect(line).not.toContain('sk-12345');
    expect(line).not.toContain('tok_abc');
    expect(line).toContain('[redacted]');
    expect(line).toContain('coding-quality');
  });

  it('carries the fields observability needs', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', format: 'json', write: (l) => lines.push(l) });
    log.child({ requestId: 'req-1', runtime: 'coding-quality' }).info('runtime ready', {
      event: 'runtime.ready',
      durationMs: 1200,
    });
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'runtime ready',
      requestId: 'req-1',
      runtime: 'coding-quality',
      event: 'runtime.ready',
      durationMs: 1200,
    });
    expect(typeof entry.time).toBe('string');
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', write: (l) => lines.push(l) });
    log.debug('hidden');
    log.info('hidden');
    log.warn('shown');
    expect(lines).toHaveLength(1);
  });
});
