import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, parseConfig } from '../src/index.js';
import type { CliError } from '../src/index.js';
import type { OptionSpec, ReservedArg } from '../src/index.js';
import { createStubAdapter, testLocation } from './helpers/stubs.js';

/**
 * Configuration loading (spec §12).
 *
 * These cover the *mechanism* — how core validates, which errors it raises, and
 * where they land. What a particular runtime's flags mean is that adapter's
 * business and is tested in its own package.
 */

const optionSpecs: Record<string, OptionSpec> = {
  context_window: { flag: '--context-window' },
  // Server-scoped, so it must also be a curated option to be accepted at all.
  model_dir: { flag: '--model-dir' },
  batching_preset: { flag: '--batching-preset' },
  context_length: { flag: '-c, --context-length' },
};

const reservedArgs: ReservedArg[] = [
  {
    flags: ['-p', '--port'],
    optionKeys: ['port'],
    reason: 'core must know the proxy target',
    insteadUse: "the entry's `port:` field",
  },
  {
    flags: ['--ttl'],
    reason: 'an idle auto-unload would drop the model behind the gateway’s back',
    insteadUse: 'nothing — the gateway owns residency',
  },
];

const registry = () => {
  return createAdapterRegistry([
    createStubAdapter({ optionSpecs, reservedArgs, serverScopedOptionKeys: ['model_dir'] }),
    createStubAdapter({ id: 'other' }),
  ]);
};

/** The runtimes: block every model fixture below needs, kept out of the way. */
const STUB = 'runtimes:\n  stub: { adapter: stub, port: 8000 }\n';

const load = (yaml: string) => parseConfig(registry(), yaml, testLocation());

const expectCliError = (fn: () => unknown, code: string): CliError => {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ namespace: 'cli' });
    expect((error as CliError).code).toBe(code);
    return error as CliError;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
};

describe('configuration loading', () => {
  it('resolves an entry to adapter, backend model and validated options', () => {
    const config = load(`
runtimes:
  stub: { adapter: stub, port: 8000 }
models:
  quality:
    runtime: stub
    backend_model: Some-Model-27B
    options: { context_window: 131072 }
    extra_args: [--custom-flag, value]
`);
    const instance = config.models.get('quality');
    expect(instance?.runtimeId).toBe('stub');
    expect(instance?.adapterId).toBe('stub');
    expect(instance?.backendModel).toBe('Some-Model-27B');
    expect(instance?.host).toBe('127.0.0.1');
    expect(instance?.port).toBe(8000);
    expect(instance?.options).toEqual({ context_window: 131072 });
    expect(instance?.extraArgs).toEqual(['--custom-flag', 'value']);
  });

  it('uses the entry `name` as the display name when set', () => {
    const config = load(`
runtimes:
  stub: { adapter: stub, port: 8000 }
models:
  quality:
    runtime: stub
    backend_model: Vendor/Some-Model-27B
    name: Qwen 3.6-35B
`);
    expect(config.models.get('quality')?.displayName).toBe('Qwen 3.6-35B');
  });

  it('falls back to backend_model for the display name when name is unset', () => {
    const config = load(`
runtimes:
  stub: { adapter: stub, port: 8000 }
models:
  quality:
    runtime: stub
    backend_model: Some-Model-27B
`);
    expect(config.models.get('quality')?.displayName).toBe('Some-Model-27B');
  });

  it('defaults the server to loopback', () => {
    expect(load('models: {}').server).toEqual({ host: '127.0.0.1', port: 8787 });
  });

  it('reports the file it loaded', () => {
    expect(load('models: {}').location.path).toBe(testLocation().path);
  });

  it('rejects a reserved argument named as an option, and says what to use instead', () => {
    const error = expectCliError(
      () =>
        load(`${STUB}models:\n  bad: { runtime: stub, backend_model: m, options: { ttl: 300 } }`),
      'RUNTIME_OPTION_RESERVED',
    );
    expect(error.message).toContain('ttl');
    expect(error.hint).toContain('instead');
  });

  it('rejects a reserved argument in extra_args, in every spelling', () => {
    for (const arg of ['--port', '--port=1234', '-p', '--ttl=60']) {
      expectCliError(
        () =>
          load(
            `${STUB}models:\n  bad: { runtime: stub, backend_model: m, extra_args: ["${arg}"] }`,
          ),
        'RUNTIME_OPTION_RESERVED',
      );
    }
  });

  it('allows a curated flag through extra_args unless the option is also set', () => {
    // extra_args is the escape hatch for the long tail, so a curated flag on its
    // own is fine; only a genuine clash is an error.
    expect(() =>
      load(
        `${STUB}models:\n  ok: { runtime: stub, backend_model: m, extra_args: [--batching-preset, agent] }`,
      ),
    ).not.toThrow();

    expectCliError(
      () =>
        load(
          `${STUB}models:\n  clash: { runtime: stub, backend_model: m, options: { batching_preset: agent }, extra_args: [--batching-preset, throughput] }`,
        ),
      'RUNTIME_OPTIONS_INVALID',
    );
  });

  it('matches a short curated alias declared as "-c, --context-length"', () => {
    expectCliError(
      () =>
        load(
          `${STUB}models:\n  clash: { runtime: stub, backend_model: m, options: { context_length: 4096 }, extra_args: ["-c", "8192"] }`,
        ),
      'RUNTIME_OPTIONS_INVALID',
    );
  });

  it('rejects an option the adapter does not declare', () => {
    const error = expectCliError(
      () =>
        load(
          `${STUB}models:\n  bad: { runtime: stub, backend_model: m, options: { nonsense: 1 } }`,
        ),
      'RUNTIME_OPTIONS_INVALID',
    );
    expect(error.hint).toContain('extra_args');
  });

  it('rejects a server-scoped option on a model, and says where it belongs', () => {
    // Two entries on one endpoint cannot disagree about model_dir: the value
    // lives on the runtime, once.
    const error = expectCliError(
      () =>
        load(
          `${STUB}models:\n  a: { runtime: stub, backend_model: a, options: { model_dir: /one } }`,
        ),
      'RUNTIME_OPTIONS_INVALID',
    );
    expect(error.message).toContain('model_dir');
    expect(error.hint).toContain('runtime');
  });

  it('rejects a model-scoped option on a runtime, and says the same in reverse', () => {
    const error = expectCliError(
      () =>
        load(
          'runtimes:\n  stub: { adapter: stub, options: { context_window: 8192 } }\nmodels:\n  a: { runtime: stub, backend_model: a }',
        ),
      'RUNTIME_OPTIONS_INVALID',
    );
    expect(error.message).toContain('context_window');
    expect(error.hint).toContain('model_dir');
  });

  it('merges the runtime\u2019s server-scoped options under the model\u2019s own', () => {
    const config = load(`
runtimes:
  stub: { adapter: stub, port: 5678, options: { model_dir: /same } }
models:
  a: { runtime: stub, backend_model: a, options: { context_window: 8192 } }
  b: { runtime: stub, backend_model: b }
`);
    // One record reaches the adapter, so it keeps one schema and one renderer.
    expect(config.models.get('a')?.options).toEqual({ model_dir: '/same', context_window: 8192 });
    expect(config.models.get('b')?.options).toEqual({ model_dir: '/same' });
  });

  it('gives every model on one runtime the same endpoint and credential', () => {
    const config = load(`
runtimes:
  stub: { adapter: stub, host: 10.0.0.2, port: 5678, auth: { api_key_env: K } }
models:
  a: { runtime: stub, backend_model: a }
  b: { runtime: stub, backend_model: b }
`);
    const a = config.models.get('a');
    const b = config.models.get('b');
    expect([a?.host, a?.port]).toEqual([b?.host, b?.port]);
    expect(a?.auth).toEqual(b?.auth);
  });

  it('rejects a model naming a runtime that is not declared', () => {
    const error = expectCliError(
      () => load('runtimes: {}\nmodels:\n  a: { runtime: nope, backend_model: m }'),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('nope');
    expect(error.hint).toContain('runtimes');
  });

  it('names the offending type in a validation message', () => {
    // Pins the wording contract: a validation failure has to name the expected
    // and received types, not just that something was wrong. Note what this
    // does *not* cover — zod 4 carries the wording in a locale, and only the
    // esbuild bundle tree-shakes it away, so dropping the `z.config(en())` in
    // src/config/schema.ts still passes here and fails in `dist/index.js`.
    // That half is the bundle smoke test's job (see CLAUDE.md, Packaging).
    const error = expectCliError(
      () => load('runtimes:\n  a: { adapter: stub, port: "8000" }\nmodels: {}\n'),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('runtimes.a.port');
    expect(error.message).toContain('expected number');
    expect(error.message).toContain('received string');
  });

  it('refuses the pre-split shape and says where each key went', () => {
    // `.strict()` alone would call `adapter:` an unrecognized key, which says
    // nothing about where it moved to.
    const error = expectCliError(
      () => load('models:\n  a: { adapter: stub, backend_model: m, port: 8000 }'),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('runtime:');
    expect(error.message).toContain('port');
    expect(error.hint).toContain('runtimes:');
  });

  it('lists declared runtimes, including one no model names', () => {
    const config = load(`
runtimes:
  stub: { adapter: stub, port: 8000 }
  spare: { adapter: other }
models:
  a: { runtime: stub, backend_model: m }
`);
    expect([...config.runtimes.keys()]).toEqual(['stub', 'spare']);
    expect(config.runtimes.get('stub')?.models).toEqual(['a']);
    expect(config.runtimes.get('spare')?.models).toEqual([]);
  });

  it('rejects an unknown adapter and malformed YAML', () => {
    expectCliError(
      () =>
        load('runtimes:\n  x: { adapter: nope }\nmodels:\n  x: { runtime: x, backend_model: m }'),
      'CONFIG_INVALID',
    );
    expectCliError(() => load('models: [oh no\n  ]['), 'CONFIG_INVALID');
  });

  it('rejects an agents role that names an unknown model id', () => {
    const error = expectCliError(
      () =>
        load(`
${STUB}models:
  a: { runtime: stub, backend_model: m }
agents:
  claude: { opus: renamed-away }
`),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('renamed-away');
  });

  it('accepts an agents block whose roles all resolve', () => {
    const config = load(`
${STUB}models:
  a: { runtime: stub, backend_model: m }
agents:
  claude: { opus: a, sonnet: a }
  codex: { model: a, reasoning_effort: high }
  opencode: { default: a }
`);
    expect(config.agents?.claude?.opus).toBe('a');
    expect(config.agents?.codex?.reasoning_effort).toBe('high');
  });

  it('carries an auth block through as a reference, never a value', () => {
    const config = load(
      'runtimes:\n  stub: { adapter: stub, auth: { api_key_env: SOME_VAR } }\nmodels:\n  a: { runtime: stub, backend_model: m }',
    );
    expect(config.models.get('a')?.auth).toEqual({ apiKeyEnv: 'SOME_VAR', apiKeyFile: undefined });
  });

  it('treats two entries with the same backend model but different options as distinct instances', () => {
    const config = load(`
${STUB}models:
  turbo: { runtime: stub, backend_model: Same-Model, options: { context_window: 8192 } }
  long:  { runtime: stub, backend_model: Same-Model, options: { context_window: 131072 } }
`);
    // The scheduler compares entry ids, never backend model names (§9), so these
    // are two runtime instances that happen to serve the same model.
    expect(config.models.get('turbo')?.options).not.toEqual(config.models.get('long')?.options);
    expect(config.models.get('turbo')?.backendModel).toBe(config.models.get('long')?.backendModel);
  });
});

/**
 * `keep_resident` (spec §8, §12).
 *
 * The flag is a scheduling decision, so core owns it outright — it is not an
 * adapter option and renders no flag. What core has to decide at load time is
 * whether the entry can be kept at all: a single-model server cannot hold one
 * model open while another entry needs that same server stopped.
 */
describe('runtime discovery flag', () => {
  it('defaults to true and is carried onto the resolved runtime', () => {
    const config = load(
      'runtimes:\n  a: { adapter: stub, port: 8000 }\n  b: { adapter: stub, port: 8001, discovery: false }\nmodels: {}\n',
    );
    expect(config.runtimes.get('a')!.discovery).toBe(true);
    expect(config.runtimes.get('b')!.discovery).toBe(false);
  });

  it('keeps an excluded runtime in the map, so its models still resolve', () => {
    // The flag is about discovery only. Dropping the runtime here would break
    // model resolution and, through it, serving.
    const config = load(
      `${STUB}runtimes:\n  manual: { adapter: stub, port: 8001, discovery: false }\nmodels:\n  m: { runtime: manual, backend_model: m }\n`.replace(
        STUB,
        '',
      ),
    );
    expect(config.runtimes.get('manual')!.models).toEqual(['m']);
    expect(config.models.get('m')!.runtimeId).toBe('manual');
  });

  it('rejects a non-boolean', () => {
    expectCliError(
      () =>
        load('runtimes:\n  a: { adapter: stub, port: 8000, discovery: sometimes }\nmodels: {}\n'),
      'CONFIG_INVALID',
    );
  });
});

describe('keep_resident', () => {
  it('defaults to false and is carried onto the instance', () => {
    const config = load(
      'runtimes:\n  stub: { adapter: stub, port: 8000 }\n  other-runtime: { adapter: other, port: 8001 }\nmodels:\n  a: { runtime: stub, backend_model: m-a }\n  b: { runtime: other-runtime, backend_model: m-b, keep_resident: true }\n',
    );
    expect(config.models.get('a')!.keepResident).toBe(false);
    expect(config.models.get('b')!.keepResident).toBe(true);
  });

  it('rejects a kept entry sharing a stop_server runtime with another entry', () => {
    const error = expectCliError(
      () =>
        load(
          `${STUB}models:\n  small: { runtime: stub, backend_model: m-small, keep_resident: true }\n  big: { runtime: stub, backend_model: m-big }\n`,
        ),
      'CONFIG_INVALID',
    );
    // Acquiring `big` would run stub's stop command against the very server
    // holding `small`, so the flag could not survive its first switch.
    expect(error.message).toContain('keep_resident');
    expect(error.message).toContain('big');
    expect(error.hint).toContain('different port');
  });

  it('rejects a kept entry whose stop_server port is claimed by another runtime', () => {
    const error = expectCliError(
      () =>
        load(
          'runtimes:\n  small: { adapter: stub, port: 8000 }\n  big: { adapter: stub, port: 8000 }\nmodels:\n  kept: { runtime: small, backend_model: m-small, keep_resident: true }\n  other: { runtime: big, backend_model: m-big }\n',
        ),
      'CONFIG_INVALID',
    );
    // Two runtime keys, one server: the port is what the stop command names.
    expect(error.message).toContain('127.0.0.1:8000');
    expect(error.message).toContain('other');
  });

  it('accepts a kept entry that owns its stop_server runtime alone', () => {
    const config = load(
      'runtimes:\n  small: { adapter: stub, port: 8001 }\n  big: { adapter: stub, port: 8000 }\nmodels:\n  kept: { runtime: small, backend_model: m-small, keep_resident: true }\n  a: { runtime: big, backend_model: m-a }\n  b: { runtime: big, backend_model: m-b }\n',
    );
    expect(config.models.get('kept')!.keepResident).toBe(true);
  });

  it('accepts a kept entry sharing an unload_model runtime, which can hold both', () => {
    const registryWithMulti = createAdapterRegistry([
      createStubAdapter({ id: 'multi', modelRelease: 'unload_model' }),
    ]);
    const config = parseConfig(
      registryWithMulti,
      'runtimes:\n  lms: { adapter: multi, port: 1234 }\nmodels:\n  kept: { runtime: lms, backend_model: m-small, keep_resident: true }\n  big: { runtime: lms, backend_model: m-big }\n',
      testLocation(),
    );
    expect(config.models.get('kept')!.keepResident).toBe(true);
  });
});

/**
 * `disabled` (spec §12).
 *
 * A catalogue flag, so loading is exactly where it does *not* act: the entry
 * parses, resolves and reaches the instance like any other. What it excludes is
 * tested where the exclusions live — resolution, `/v1/models` and `apply`.
 */
describe('disabled', () => {
  it('defaults to false and is carried onto the instance', () => {
    const config = load(
      `${STUB}models:\n  a: { runtime: stub, backend_model: m-a }\n  b: { runtime: stub, backend_model: m-b, disabled: true }\n`,
    );
    expect(config.models.get('a')!.disabled).toBe(false);
    expect(config.models.get('b')!.disabled).toBe(true);
  });

  it('still loads when an agents: role names a disabled entry', () => {
    // Deliberately not a load-time failure: disabling one entry must not stop
    // `serve`, `models`, `doctor` and `probe` from reading the file. `apply`
    // and `doctor` are what refuse the mapping (§23).
    const config = load(
      `${STUB}models:\n  a: { runtime: stub, backend_model: m-a, disabled: true }\nagents:\n  opencode: { default: a }\n`,
    );
    expect(config.agents?.opencode?.default).toBe('a');
  });

  it('does not excuse a kept entry from owning its stop_server runtime', () => {
    // The flag says what is served, not who owns a server. Relaxing this would
    // make enabling the sibling again a config error raised by an edit that did
    // not touch either entry's runtime.
    const error = expectCliError(
      () =>
        load(
          `${STUB}models:\n  small: { runtime: stub, backend_model: m-small, keep_resident: true }\n  big: { runtime: stub, backend_model: m-big, disabled: true }\n`,
        ),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('big');
  });
});
