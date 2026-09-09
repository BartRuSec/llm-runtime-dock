import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configWriteTarget,
  homeConfigPath,
  probeAdapter,
  renderDiscoveredModels,
  saveDiscovery,
  suggestKeyForServedId,
  validateDiscoveredId,
} from '../src/index.js';
import type { CliError } from '../src/index.js';
import type { AdapterProbeOutcome, ConfigLocation } from '../src/index.js';
import { createStubAdapter } from './helpers/stubs.js';

/** Discovery (spec §22): what core does with whatever an adapter reports. */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-core-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `found: true` pins the write target inside the temp directory. A location with
 * `found: false` deliberately falls back to the user's real home config (§12),
 * so no test may construct one and then write.
 */
const location = (path: string, found = true): ConfigLocation => ({
  path,
  found,
  candidates: [path],
  source: 'flag',
});

const outcome = (
  adapter: string,
  url: string,
  ids: string[],
  runtimeId = adapter,
): AdapterProbeOutcome => ({
  adapter,
  runtimeId,
  result: { status: 'running', url, models: ids.map((id) => ({ id })) },
  skipped: [],
});

describe('probing an adapter', () => {
  it('passes through each outcome, including the two that write nothing', async () => {
    for (const status of [
      'running',
      'not_running',
      'auth_required',
      'not_installed',
      'foreign_server',
    ] as const) {
      const result =
        status === 'running'
          ? { status, url: 'http://127.0.0.1:1', models: [{ id: 'a' }] }
          : status === 'not_installed'
            ? { status, url: 'http://127.0.0.1:1', detail: 'x not found', executable: 'x' }
            : status === 'foreign_server'
              ? { status, url: 'http://127.0.0.1:1', detail: 'not this runtime' }
              : { status, url: 'http://127.0.0.1:1' };
      const probed = await probeAdapter(createStubAdapter({ probeResult: result }));
      // "running, credential required" must never collapse into "not running".
      expect(probed.result.status).toBe(status);
    }
  });

  it('turns a thrown probe into "not running" rather than failing', async () => {
    const adapter = createStubAdapter();
    adapter.probe = async () => {
      throw new Error('ECONNREFUSED');
    };
    const probed = await probeAdapter(adapter);
    expect(probed.result.status).toBe('not_running');
  });

  it('skips a model the runtime itself declares unusable, and says why', async () => {
    const probed = await probeAdapter(
      createStubAdapter({
        probeResult: {
          status: 'running',
          url: 'http://127.0.0.1:1',
          models: [
            { id: 'servable' },
            { id: 'no-contract', unusable: 'the runtime reports no valid contract' },
          ],
        },
      }),
    );
    if (probed.result.status !== 'running') throw new Error('expected running');
    // Writing it would produce an entry whose first switch fails.
    expect(probed.result.models.map((m) => m.id)).toEqual(['servable']);
    expect(probed.skipped).toEqual([
      { id: 'no-contract', reason: 'the runtime reports no valid contract' },
    ]);
  });

  it('skips ids that are unsafe to write, and never rewrites them', async () => {
    const probed = await probeAdapter(
      createStubAdapter({
        probeResult: {
          status: 'running',
          url: 'http://127.0.0.1:1',
          models: [{ id: 'good' }, { id: '--rm-rf' }, { id: 'has space' }],
        },
      }),
    );
    if (probed.result.status !== 'running') throw new Error('expected running');
    expect(probed.result.models.map((m) => m.id)).toEqual(['good']);
    expect(probed.skipped.map((s) => s.id)).toEqual(['--rm-rf', 'has space']);
    expect(probed.skipped[0]?.reason).toContain('flag');
  });

  it('requires an explicit url when the adapter declares no default target', async () => {
    const adapter = createStubAdapter();
    (adapter as { defaultProbeTarget: string | null }).defaultProbeTarget = null;
    await expect(probeAdapter(adapter)).rejects.toMatchObject({ namespace: 'cli' });
  });
});

describe('discovered id validation', () => {
  it('accepts what a runtime plausibly serves', () => {
    for (const id of ['Qwen3.8-27B', 'a_b.c-d@e:1+2', 'llama-3b']) {
      expect(validateDiscoveredId(id).ok).toBe(true);
    }
  });

  it('rejects anything that could be misread or is not a plain id', () => {
    for (const id of ['-leading-dash', 'has space', '../escape', '', 'x'.repeat(201)]) {
      expect(validateDiscoveredId(id).ok).toBe(false);
    }
  });
});

describe('deriving a config key from a served id', () => {
  it('leaves an id that is already a usable key exactly as it is', () => {
    for (const id of ['GPT-4o', 'Qwen3.8-27B', 'a_b.c-d@e:1+2']) {
      expect(suggestKeyForServedId(id)).toBe(id);
    }
  });

  it('flattens the separator rather than dropping the publisher', () => {
    expect(suggestKeyForServedId('google/gemma-4-26b-a4b-qat')).toBe('google-gemma-4-26b-a4b-qat');
    expect(suggestKeyForServedId('Qwen/Qwen3-72B')).toBe('qwen-qwen3-72b');
  });

  it('keeps two publishers of the same model on two keys', () => {
    const a = suggestKeyForServedId('google/gemma-4-26b-a4b-qat');
    const b = suggestKeyForServedId('lmstudio-community/gemma-4-26b-a4b-qat');
    expect(a).not.toBe(b);
  });

  it('derives a key that passes the rule it exists to satisfy', () => {
    const ids = [
      'google/gemma-4-26b-a4b-qat',
      'mlx-community/Llama-3.3-70B-Instruct-4bit',
      'bartowski/Qwen_Qwen3-32B-GGUF',
      'text-embedding-nomic-embed-text-v1.5',
    ];
    for (const id of ids) {
      expect(validateDiscoveredId(suggestKeyForServedId(id)).ok).toBe(true);
    }
  });

  it('falls back to the served id when nothing usable is left', () => {
    // Unreachable through probeAdapter — validateBackendModelRef rejects such
    // an id first — so this pins the guard, not a real path.
    expect(suggestKeyForServedId('///')).toBe('///');
  });
});

describe('writing discovered configuration', () => {
  it('creates a file when none exists at the resolved path', () => {
    const path = join(dir, 'config.yaml');
    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['qwen38'])],
      location: location(path),
      defaultServer: { host: '127.0.0.1', port: 8787 },
    });
    expect(result.written).toBe(true);
    expect(result.backup).toBeNull();
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('qwen38');
    expect(written).toContain('port: 8787');
  });

  it('reports an entry that names no adapter instead of silently stepping around it', () => {
    const path = join(dir, 'config.yaml');
    // A hand-edited entry with no `adapter:` key. Replacement works off that
    // key, so nothing owns this one — and `loadConfig` rejects the whole file.
    writeFileSync(
      path,
      'server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  stub: { adapter: stub, port: 8000 }\nmodels:\n  handwritten: { backend_model: some/model }\n  old: { runtime: stub, backend_model: old }\n',
    );

    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['fresh'])],
      location: location(path),
      remove: ['old'],
    });

    expect(result.unowned).toEqual([{ id: 'handwritten', reason: 'names no runtime' }]);
    expect(result.removed).toEqual(['old']);
    // Left as-is: save may not delete what it does not own.
    expect(readFileSync(path, 'utf8')).toContain('handwritten');
  });

  it('rewrites an unowned entry whose key it discovers, rather than calling it a collision', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      'server: { host: 127.0.0.1, port: 8787 }\nmodels:\n  fresh: { backend_model: stale }\n',
    );

    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['fresh'])],
      location: location(path),
    });

    // An entry declaring no adapter is nobody's property, so writing the key is
    // a repair — not `already configured for adapter ""`. It is an existing key,
    // so it is refreshed in place like any other rediscovered entry.
    expect(result.updated.models).toEqual(['fresh']);
    expect(result.added.models).toEqual([]);
    expect(result.unowned).toEqual([]);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('runtime: stub');
    expect(written).not.toContain('backend_model: stale');
  });

  const twoRuntimes =
    'server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  stub: { adapter: stub, port: 8000 }\n  other: { adapter: other, port: 1234 }\nmodels:\n  old: { runtime: stub, backend_model: old }\n  keep: { runtime: other, backend_model: keep }\n';

  it("reports an unfound entry as stale rather than deleting it, and never touches another adapter's", () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, twoRuntimes);

    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['fresh'])],
      location: location(path),
    });

    expect(result.backup).toBeTruthy();
    expect(result.stale).toEqual([{ id: 'old', adapter: 'stub', runtime: 'stub' }]);
    expect(result.removed).toEqual([]);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('fresh');
    // Nobody consented, so it stays — an idle backend is not a deleted model.
    expect(written).toContain('backend_model: old');
    // Another adapter's entry is untouched, and is never even called stale.
    expect(written).toContain('keep');
  });

  it('deletes a stale entry when, and only when, the caller approves it', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, twoRuntimes);

    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['fresh'])],
      location: location(path),
      remove: ['old', 'keep'],
    });

    expect(result.removed).toEqual(['old']);
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('backend_model: old');
    // `remove` names ids, but it cannot reach what this probe does not own.
    expect(written).toContain('keep');
  });

  it('keeps every option and comment on an entry the probe rediscovers', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      [
        'server: { host: 127.0.0.1, port: 8787 }',
        'runtimes: { stub: { adapter: stub, port: 8000 } }',
        'models:',
        '  tuned:',
        '    runtime: stub',
        '    backend_model: tuned',
        '    # hand-tuned, and the reason this whole rule exists',
        '    args: [--ctx, "32768"]',
        '    auth: { api_key_env: STUB_KEY }',
        '',
      ].join('\n'),
    );

    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['tuned'])],
      location: location(path),
    });

    expect(result.updated.models).toEqual(['tuned']);
    expect(result.added.models).toEqual([]);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('--ctx');
    expect(written).toContain('api_key_env: STUB_KEY');
    expect(written).toContain('# hand-tuned');
  });

  it('leaves `disabled: true` on an entry the probe rediscovers', () => {
    // The whole reason the flag exists rather than deleting the entry: the
    // probe still finds the model, and a deleted entry would come straight
    // back on the next save (§12, §22).
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      [
        'server: { host: 127.0.0.1, port: 8787 }',
        'runtimes: { stub: { adapter: stub, port: 8000 } }',
        'models:',
        '  embeddings:',
        '    runtime: stub',
        '    backend_model: embeddings',
        '    disabled: true',
        '',
      ].join('\n'),
    );

    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['embeddings'])],
      location: location(path),
    });

    expect(result.updated.models).toEqual(['embeddings']);
    expect(readFileSync(path, 'utf8')).toContain('disabled: true');
  });

  it('drops a host the probe no longer warrants instead of leaving a stale endpoint', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      'server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  stub: { adapter: stub, host: 192.168.1.20, port: 5678 }\nmodels:\n  moved: { runtime: stub, backend_model: moved }\n',
    );

    saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['moved'])],
      location: location(path),
    });

    const written = readFileSync(path, 'utf8');
    // Refreshing the port while keeping the old host would aim the entry at an
    // endpoint nothing answered. `host` is written conditionally, so it goes.
    expect(written).not.toContain('192.168.1.20');
    expect(written).toContain('port: 8000');
  });

  it("does not leave a deleted entry's comment sitting above the next one", () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      [
        'server: { host: 127.0.0.1, port: 8787 }',
        'runtimes: { stub: { adapter: stub, port: 8000 }, other: { adapter: other, port: 1234 } }',
        'models:',
        '  # about the entry below, and nothing else',
        '  gone: { runtime: stub, backend_model: gone }',
        '  kept: { runtime: other, backend_model: kept }',
        '',
      ].join('\n'),
    );

    saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['fresh'])],
      location: location(path),
      remove: ['gone'],
    });

    // `yaml` keeps the first entry's comment on the map, so a plain delete would
    // re-attach it to `kept` — an entry of an adapter this save never probed.
    const written = readFileSync(path, 'utf8');
    expect(written).not.toContain('about the entry below');
    expect(written).toContain('kept');
  });

  it('proposes no removals for an adapter that reported nothing', () => {
    const path = join(dir, 'config.yaml');
    const before =
      'server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  stub: { adapter: stub, port: 8000 }\nmodels:\n  a: { runtime: stub, backend_model: a }\n  b: { runtime: stub, backend_model: b }\n';
    writeFileSync(path, before);

    const result = saveDiscovery({
      // A server that is simply down. Asking "delete all of them?" here would be
      // the worst possible moment, so an adapter that found nothing probes
      // nothing away.
      outcomes: [
        {
          adapter: 'stub',
          runtimeId: 'stub',
          result: { status: 'not_running', url: 'http://127.0.0.1:8000' },
          skipped: [],
        },
      ],
      location: location(path),
      remove: ['a', 'b'],
    });

    expect(result.stale).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('records a host only when the endpoint is not loopback', () => {
    const path = join(dir, 'config.yaml');
    saveDiscovery({
      outcomes: [outcome('stub', 'http://192.168.1.20:5678', ['remote'])],
      location: location(path),
    });
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('host: 192.168.1.20');
    expect(written).toContain('port: 5678');
  });

  it('leaves a model that already belongs to another runtime where it is', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      'server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  other: { adapter: other, port: 1234 }\nmodels:\n  shared: { runtime: other, backend_model: shared }\n',
    );

    // It has an owner, so discovery has nothing to add. Moving it would be the
    // one thing saving must never do, and failing would block the whole save.
    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:5678', ['shared'])],
      location: location(path),
    });

    expect(result.retained).toEqual([{ id: 'shared', runtime: 'other' }]);
    expect(readFileSync(path, 'utf8')).toContain('shared: { runtime: other');
  });

  it('is not a conflict when a sibling runtime of one adapter rediscovers an owned id', () => {
    // The `keep_resident` shape: two MTPLX runtimes, one per port, both reading
    // the same installed catalogue. The 27B belongs to `mtplx`; `mtplx_resident`
    // listing it says nothing new, and must not abort the save.
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      'server: { host: 127.0.0.1, port: 8787 }\n' +
        'runtimes:\n  mtplx: { adapter: stub, port: 8000 }\n  mtplx_resident: { adapter: stub, port: 8001 }\n' +
        'models:\n  big: { runtime: mtplx, backend_model: big }\n  small: { runtime: mtplx_resident, backend_model: small }\n',
    );

    const result = saveDiscovery({
      outcomes: [
        outcome('stub', 'http://127.0.0.1:8000', ['big', 'small'], 'mtplx'),
        outcome('stub', 'http://127.0.0.1:8001', ['big', 'small'], 'mtplx_resident'),
      ],
      location: location(path),
    });

    expect(result.ambiguous).toEqual([]);
    // Each stays with its owner, and neither is offered for deletion — the
    // staleness pass must see a retained id as claimed.
    expect(result.stale).toEqual([]);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('big: { runtime: mtplx,');
    expect(written).toContain('small: { runtime: mtplx_resident,');
  });

  it('reports an unowned id two runtimes of one adapter offer, instead of guessing', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'server: { host: 127.0.0.1, port: 8787 }\nmodels: {}\n');

    const result = saveDiscovery({
      outcomes: [
        outcome('stub', 'http://127.0.0.1:8000', ['fresh'], 'mtplx'),
        outcome('stub', 'http://127.0.0.1:8001', ['fresh'], 'mtplx_resident'),
      ],
      location: location(path),
    });

    expect(result.ambiguous).toEqual([
      { id: 'fresh', adapter: 'stub', candidates: ['mtplx', 'mtplx_resident'] },
    ]);
    // Unresolved means unwritten: the rest of the save still went through.
    expect(readFileSync(path, 'utf8')).not.toContain('fresh:');
  });

  it('writes an ambiguous id once `assign` names its runtime', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'server: { host: 127.0.0.1, port: 8787 }\nmodels: {}\n');

    const result = saveDiscovery({
      outcomes: [
        outcome('stub', 'http://127.0.0.1:8000', ['fresh'], 'mtplx'),
        outcome('stub', 'http://127.0.0.1:8001', ['fresh'], 'mtplx_resident'),
      ],
      location: location(path),
      assign: { fresh: 'mtplx_resident' },
    });

    expect(result.ambiguous).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('runtime: mtplx_resident');
  });

  it('ignores an `assign` naming a runtime that did not offer the model', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'server: { host: 127.0.0.1, port: 8787 }\nmodels: {}\n');

    const result = saveDiscovery({
      outcomes: [
        outcome('stub', 'http://127.0.0.1:8000', ['fresh'], 'mtplx'),
        outcome('stub', 'http://127.0.0.1:8001', ['fresh'], 'mtplx_resident'),
      ],
      location: location(path),
      assign: { fresh: 'somewhere-else' },
    });

    // An answer is only trusted as far as the candidates go; anything else would
    // write an entry pointing at a runtime that never served it.
    expect(result.ambiguous.map((entry) => entry.id)).toEqual(['fresh']);
    expect(readFileSync(path, 'utf8')).not.toContain('somewhere-else');
  });

  it('keeps keep_resident and options when refreshing a rediscovered entry', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      'server: { host: 127.0.0.1, port: 8787 }\n' +
        'runtimes:\n  mtplx_resident: { adapter: stub, port: 8001 }\n' +
        'models:\n  small:\n    runtime: mtplx_resident\n    backend_model: small\n' +
        '    keep_resident: true\n    options:\n      context_window: 32768\n',
    );

    saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8001', ['small'], 'mtplx_resident')],
      location: location(path),
    });

    // Discovery owns `runtime` and `backend_model` and nothing else. Losing
    // `keep_resident` here would silently un-pin the model on the next probe.
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('keep_resident: true');
    expect(written).toContain('context_window: 32768');
  });

  it('fails when two adapters discover the same id', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'server: { host: 127.0.0.1, port: 8787 }\nmodels: {}\n');
    try {
      saveDiscovery({
        outcomes: [
          outcome('stub', 'http://127.0.0.1:1234', ['same']),
          outcome('other', 'http://127.0.0.1:5678', ['same']),
        ],
        location: location(path),
      });
      throw new Error('expected a conflict');
    } catch (error) {
      expect((error as CliError).code).toBe('DISCOVERY_NAME_CONFLICT');
    }
  });

  it('performs the same check on a dry run and writes nothing', () => {
    const path = join(dir, 'config.yaml');
    const before =
      'server: { host: 127.0.0.1, port: 8787 }\nruntimes:\n  stub: { adapter: stub, port: 8000 }\nmodels:\n  a: { runtime: stub, backend_model: a }\n';
    writeFileSync(path, before);

    const result = saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['b'])],
      location: location(path),
      dryRun: true,
    });
    expect(result.written).toBe(false);
    expect(result.content).toContain('b:');
    // The plan a dry run reports is the same one a write would act on, which is
    // what lets the CLI ask about removals before committing to anything.
    expect(result.stale).toEqual([{ id: 'a', adapter: 'stub', runtime: 'stub' }]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('preserves comments and unrelated top-level keys', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      '# hand-written\nserver:\n  host: 127.0.0.1\n  port: 9000\nruntimes:\n  stub: { adapter: stub, port: 8000 }\nmodels:\n  a: { runtime: stub, backend_model: a }\nagents:\n  opencode:\n    default: a\n',
    );
    saveDiscovery({
      outcomes: [outcome('stub', 'http://127.0.0.1:8000', ['b'])],
      location: location(path),
    });
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('# hand-written');
    expect(written).toContain('port: 9000');
    expect(written).toContain('agents:');
  });

  it('resolves an unfound location to the home config, never the probed path', () => {
    const notFound = location(join(dir, 'llm-runtime-dock.yaml'), false);
    expect(configWriteTarget(notFound)).toBe(homeConfigPath());
    expect(configWriteTarget(location(join(dir, 'config.yaml')))).toContain(dir);
  });
});

describe('rendering discovered configuration for a bare probe', () => {
  it('builds entries the same way --save does', () => {
    const preview = renderDiscoveredModels([outcome('stub', 'http://127.0.0.1:8000', ['a', 'b'])]);
    expect(preview?.ids).toEqual(['a', 'b']);
    expect(preview?.yaml).toContain('adapter: stub');
    expect(preview?.yaml).toContain('runtime: stub');
    expect(preview?.yaml).toContain('backend_model: a');
    expect(preview?.yaml).toContain('port: 8000');
    // The runtime block comes first, so the file reads top-down.
    expect(preview?.yaml.indexOf('runtimes:')).toBeLessThan(preview!.yaml.indexOf('models:'));
    // Loopback is the default and is not restated.
    expect(preview?.yaml).not.toContain('host:');
  });

  it('reports a cross-runtime collision instead of throwing', () => {
    // A bare probe is read-only and must never fail, even where --save would.
    const preview = renderDiscoveredModels([
      outcome('stub', 'http://127.0.0.1:1234', ['same']),
      outcome('other', 'http://127.0.0.1:5678', ['same']),
    ]);
    expect(preview?.collisions).toEqual(['same']);
    expect(preview?.ids).toEqual(['same']);
  });

  it('renders a configured model under its existing owner, not the first prober', () => {
    // Both MTPLX runtimes read one catalogue, so the id appears twice. Rendering
    // it under whichever was probed first contradicted the file on disk — and
    // told the user their kept model lived on the wrong runtime.
    const preview = renderDiscoveredModels(
      [
        outcome('stub', 'http://127.0.0.1:8000', ['small'], 'mtplx'),
        outcome('stub', 'http://127.0.0.1:8001', ['small'], 'mtplx_resident'),
      ],
      new Map([['small', 'mtplx_resident']]),
    );

    expect(preview?.collisions).toEqual([]);
    expect(preview?.yaml).toContain('runtime: mtplx_resident');
    expect(preview?.yaml).not.toContain('runtime: mtplx\n');
  });

  it('still reports a collision for an id nothing owns yet', () => {
    const preview = renderDiscoveredModels(
      [
        outcome('stub', 'http://127.0.0.1:8000', ['fresh'], 'mtplx'),
        outcome('stub', 'http://127.0.0.1:8001', ['fresh'], 'mtplx_resident'),
      ],
      new Map(),
    );
    expect(preview?.collisions).toEqual(['fresh']);
  });

  it('builds entries from the installed catalogue, not from what is loaded', () => {
    // MTPLX loads `Vendor/Model-MTPLX` and then serves it under a different id.
    // Taking both lists wrote the model twice, the second time under a reference
    // `serve --model` does not accept.
    const preview = renderDiscoveredModels([
      {
        adapter: 'mtplx',
        runtimeId: 'mtplx',
        result: {
          status: 'running',
          url: 'http://127.0.0.1:8000',
          models: [{ id: 'mtplx-model-optimized' }],
          available: [{ id: 'Vendor/Model-MTPLX', suggestedId: 'model' }],
        },
        skipped: [],
      },
    ]);

    expect(preview?.ids).toEqual(['model']);
    expect(preview?.yaml).toContain('backend_model: Vendor/Model-MTPLX');
    // The served id is a status display, never a launch reference.
    expect(preview?.yaml).not.toContain('mtplx-model-optimized');
  });

  it('returns nothing when there is not even an endpoint to record', () => {
    // A runtime whose executable is missing has no endpoint worth printing; one
    // that is merely down does, and is covered above.
    expect(
      renderDiscoveredModels([
        {
          adapter: 'stub',
          runtimeId: 'stub',
          result: {
            status: 'not_installed',
            url: 'http://x',
            detail: 'stub not found',
            executable: 'stub',
          },
          skipped: [],
        },
      ]),
    ).toBeNull();
  });

  it('shows a runtime whose server is down, exactly as --save would write it', () => {
    // The drift that matters: `--save` records the endpoint of a backend that is
    // merely off, because that is what the gateway needs in order to start it.
    // A preview that hid it would be advertising a different command.
    const outcome: AdapterProbeOutcome = {
      adapter: 'stub',
      runtimeId: 'stub',
      result: { status: 'not_running', url: 'http://127.0.0.1:1234' },
      skipped: [],
    };
    const preview = renderDiscoveredModels([outcome]);
    expect(preview?.ids).toEqual([]);
    expect(preview?.yaml).toContain('adapter: stub');
    expect(preview?.yaml).toContain('port: 1234');

    const path = join(dir, 'config.yaml');
    saveDiscovery({ outcomes: [outcome], location: location(path) });
    // Same condition on both sides, checked against the file rather than by
    // reading the two functions and hoping.
    expect(readFileSync(path, 'utf8')).toContain('adapter: stub');
  });

  it('writes no runtime for a backend that is absent or not its own', () => {
    for (const result of [
      {
        status: 'not_installed' as const,
        url: 'http://127.0.0.1:1234',
        detail: 'stub not found',
        executable: 'stub',
      },
      { status: 'foreign_server' as const, url: 'http://127.0.0.1:1234', detail: 'not stub' },
    ]) {
      const outcome: AdapterProbeOutcome = {
        adapter: 'stub',
        runtimeId: 'stub',
        result,
        skipped: [],
      };
      expect(renderDiscoveredModels([outcome])).toBeNull();

      const path = join(dir, `${result.status}.yaml`);
      const saved = saveDiscovery({ outcomes: [outcome], location: location(path) });
      // Recording this endpoint would aim the runtime at a server that is not
      // its own, and the first switch would talk to the wrong backend.
      expect(saved.added).toEqual({ runtimes: [], models: [] });
      expect(saved.stale).toEqual([]);
    }
  });
});
