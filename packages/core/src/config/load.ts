import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type * as z from 'zod';
import type { AdapterRegistry } from '../registry.js';
import { cliError } from '../errors.js';
import type { CliError } from '../errors.js';
import type { AuthConfig, ModelRelease, RuntimeInstance } from '../types.js';
import { checkExtraArgs, checkOptionKeys } from './reserved.js';
import type { ConfigLocation } from './paths.js';
import { resolveConfigLocation } from './paths.js';
import type { RawAgents, RawConfig, RawRuntimeEntry, ServerConfig } from './schema.js';
import { rawConfigSchema } from './schema.js';

/**
 * One entry of the `runtimes:` map, resolved (§12).
 *
 * Distinct from `RuntimeInstance`, which is the *pairing* of a model with one of
 * these. A declared runtime with no models on it is legal — it is the first
 * thing `probe --save` writes — so this map is carried separately rather than
 * derived from `models`.
 */
export interface ResolvedRuntime {
  readonly id: string;
  readonly adapterId: string;
  readonly host: string;
  readonly port: number | undefined;
  readonly auth: AuthConfig | undefined;
  /** Logical model ids that name this runtime, in configuration order. */
  readonly models: readonly string[];
  /**
   * Whether `lrd probe` may look at this runtime (§22). `false` means it is
   * managed by hand. Read only by the CLI: serving must not depend on it.
   */
  readonly discovery: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface DockConfig {
  readonly location: ConfigLocation;
  readonly server: ServerConfig;
  /** The declared runtimes, keyed by the `runtimes:` key. */
  readonly runtimes: ReadonlyMap<string, ResolvedRuntime>;
  /** Fully resolved runtime instances, keyed by logical model id. */
  readonly models: ReadonlyMap<string, RuntimeInstance>;
  readonly agents: RawAgents | undefined;
  readonly raw: RawConfig;
}

export interface LoadConfigOptions {
  readonly explicitPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Parse this text instead of reading from disk. Used by tests and `--dry-run`. */
  readonly contents?: string;
}

const DEFAULT_HOST = '127.0.0.1';

export const loadConfig = (
  registry: AdapterRegistry,
  options: LoadConfigOptions = {},
): DockConfig => {
  const location = resolveConfigLocation(options);
  const contents = options.contents ?? readConfigFile(location);
  const raw = parseAndValidate(contents, location);
  return buildConfig(raw, location, registry);
};

/** Parse and validate an already-loaded YAML string. */
export const parseConfig = (
  registry: AdapterRegistry,
  contents: string,
  location: ConfigLocation,
): DockConfig => {
  return buildConfig(parseAndValidate(contents, location), location, registry);
};

const readConfigFile = (location: ConfigLocation): string => {
  if (!location.found) {
    throw cliError('CONFIG_INVALID', `no configuration file found`, {
      details: { looked: [...location.candidates] },
      hint: 'run `lrd probe <adapter> --save` to create one, or pass --config <path>',
    });
  }
  try {
    return readFileSync(location.path, 'utf8');
  } catch (cause) {
    throw cliError('CONFIG_INVALID', `cannot read ${location.path}`, { cause });
  }
};

const parseAndValidate = (contents: string, location: ConfigLocation): RawConfig => {
  let parsed: unknown;
  try {
    parsed = parseYaml(contents) ?? {};
  } catch (cause) {
    throw cliError(
      'CONFIG_INVALID',
      `${location.path}: invalid YAML — ${(cause as Error).message}`,
      {
        details: { path: location.path },
        cause,
      },
    );
  }
  checkLegacyShape(parsed, location);
  const result = rawConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw cliError('CONFIG_INVALID', `${location.path}: ${formatZodError(result.error)}`, {
      details: { path: location.path },
    });
  }
  return result.data;
};

/** Keys that belong on the runtime, not on a model entry (§12). */
const MOVED_TO_RUNTIME = [
  'host',
  'port',
  'auth',
  'surfaces',
  'process',
  'health',
  'model_discovery',
  'endpoint',
] as const;

/**
 * `adapter:` on a model entry is the pre-split spelling (§12).
 *
 * `.strict()` would report it as an unrecognized key, which says nothing about
 * where it went — and a zod `superRefine` never runs, because a strict object
 * fails before its refinements. So this is checked here, before validation.
 */
const checkLegacyShape = (parsed: unknown, location: ConfigLocation): void => {
  if (!parsed || typeof parsed !== 'object') return;
  const models = (parsed as { models?: unknown }).models;
  if (!models || typeof models !== 'object') return;

  for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!('adapter' in entry)) continue;
    const moved = MOVED_TO_RUNTIME.filter((key) => key in entry);
    const alsoMoved =
      moved.length > 0 ? ` These keys also moved to the runtime: ${moved.join(', ')}.` : '';
    const adapterName = String((entry as { adapter?: unknown }).adapter ?? '<adapter>');
    throw cliError(
      'CONFIG_INVALID',
      `${location.path}: models.${id} still uses the pre-split shape: "adapter:" now belongs to a runtimes: entry, and the model names it with "runtime:".${alsoMoved}`,
      {
        details: { path: location.path, entry: id, moved: [...moved] },
        hint: `declare it once under runtimes:, e.g. \`runtimes:\n  ${adapterName}:\n    adapter: ${adapterName}\`, then set "runtime: ${adapterName}" on each model that used it`,
      },
    );
  }
};

const formatZodError = (error: z.ZodError): string => {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
};

const buildConfig = (
  raw: RawConfig,
  location: ConfigLocation,
  registry: AdapterRegistry,
): DockConfig => {
  // Resolve the declared runtimes first: a model entry is meaningless until the
  // server it names exists, and the adapter comes from the runtime now.
  const runtimeAdapters = new Map<string, ReturnType<AdapterRegistry['require']>>();
  const runtimeModels = new Map<string, string[]>();
  for (const [runtimeId, entry] of Object.entries(raw.runtimes)) {
    const adapter = registry.require(entry.adapter, `runtimes.${runtimeId}`);
    checkOptionKeys(adapter, `runtimes.${runtimeId}`, entry.options, 'runtime');
    runtimeAdapters.set(runtimeId, adapter);
    runtimeModels.set(runtimeId, []);
  }

  const models = new Map<string, RuntimeInstance>();

  for (const [id, entry] of Object.entries(raw.models)) {
    const runtimeEntry = raw.runtimes[entry.runtime];
    const adapter = runtimeAdapters.get(entry.runtime);
    if (!runtimeEntry || !adapter) {
      const known = Object.keys(raw.runtimes);
      throw cliError(
        'CONFIG_INVALID',
        `models.${id}.runtime names unknown runtime "${entry.runtime}"`,
        {
          details: { entry: id, runtime: entry.runtime, known },
          hint:
            known.length === 0
              ? `no runtimes are declared; add a runtimes: section, or run \`lrd probe <adapter> --save\``
              : `declared runtimes: ${known.join(', ')}`,
        },
      );
    }

    // Reserved arguments are rejected, never silently merged (§12).
    checkOptionKeys(adapter, `models.${id}`, entry.options, 'model');
    checkExtraArgs(adapter, `models.${id}`, entry.extra_args, entry.options);

    // One record, one schema, one renderer: the adapter never learns that the
    // options arrived from two blocks. The model's own keys win, but after the
    // scope check above they cannot overlap.
    const merged = { ...(runtimeEntry.options ?? {}), ...(entry.options ?? {}) };
    const options = adapter.validateOptions(merged, {
      id,
      runtimeId: entry.runtime,
      entry: entry as Readonly<Record<string, unknown>>,
      runtimeEntry: runtimeEntry as Readonly<Record<string, unknown>>,
    });

    models.set(id, {
      id,
      runtimeId: entry.runtime,
      adapterId: adapter.id,
      backendModel: entry.backend_model,
      displayName: entry.name ?? entry.backend_model,
      host: runtimeEntry.host ?? DEFAULT_HOST,
      port: runtimeEntry.port,
      options,
      extraArgs: entry.extra_args ?? [],
      keepResident: entry.keep_resident ?? false,
      disabled: entry.disabled ?? false,
      auth: toAuthConfig(runtimeEntry),
      raw: entry as Readonly<Record<string, unknown>>,
      rawRuntime: runtimeEntry as Readonly<Record<string, unknown>>,
    });
    runtimeModels.get(entry.runtime)?.push(id);
  }

  const runtimes = new Map<string, ResolvedRuntime>();
  for (const [runtimeId, entry] of Object.entries(raw.runtimes)) {
    runtimes.set(runtimeId, {
      id: runtimeId,
      adapterId: runtimeAdapters.get(runtimeId)!.id,
      host: entry.host ?? DEFAULT_HOST,
      port: entry.port,
      auth: toAuthConfig(entry),
      models: runtimeModels.get(runtimeId) ?? [],
      discovery: entry.discovery ?? true,
      raw: entry as Readonly<Record<string, unknown>>,
    });
  }

  checkKeptResidency(models, runtimes, runtimeAdapters);
  checkAgentRoles(raw.agents, models);

  return { location, server: raw.server, runtimes, models, agents: raw.agents, raw };
};

/**
 * A `keep_resident` entry on a `stop_server` runtime holds a whole server (§8).
 *
 * That is legal — a small model on its own port is exactly the intended shape —
 * but only while nothing else has to stop that server. Two entries on one
 * `stop_server` runtime cannot both be served: acquiring the second runs the
 * first's stop command, and the kept model would be unloaded by the very
 * mechanism that is supposed to leave it alone.
 *
 * The port is checked as well as the runtime key, because two runtime entries
 * pointing at one port are the same collision wearing a disguise: `mtplx stop
 * --port 8000` does not care which YAML key asked for it.
 */
const checkKeptResidency = (
  models: ReadonlyMap<string, RuntimeInstance>,
  runtimes: ReadonlyMap<string, ResolvedRuntime>,
  adapters: ReadonlyMap<string, { readonly id: string; readonly modelRelease: ModelRelease }>,
): void => {
  for (const instance of models.values()) {
    if (!instance.keepResident) continue;
    const adapter = adapters.get(instance.runtimeId);
    if (!adapter || adapter.modelRelease !== 'stop_server') continue;

    const siblings = (runtimes.get(instance.runtimeId)?.models ?? []).filter(
      (id) => id !== instance.id,
    );
    if (siblings.length > 0) {
      throw keptConflict(instance, adapter.id, `runtimes.${instance.runtimeId}`, siblings);
    }

    // A different runtime key on the same endpoint is the same server.
    const collisions: string[] = [];
    for (const other of runtimes.values()) {
      if (other.id === instance.runtimeId) continue;
      const otherAdapter = adapters.get(other.id);
      if (!otherAdapter || otherAdapter.modelRelease !== 'stop_server') continue;
      if (other.host !== instance.host || other.port !== instance.port) continue;
      collisions.push(...other.models);
    }
    if (collisions.length > 0) {
      throw keptConflict(
        instance,
        adapter.id,
        `${instance.host}:${instance.port ?? '(default)'}`,
        collisions,
      );
    }
  }
};

const keptConflict = (
  instance: RuntimeInstance,
  adapterId: string,
  shared: string,
  others: readonly string[],
): CliError =>
  cliError(
    'CONFIG_INVALID',
    `models.${instance.id} sets keep_resident, but ${adapterId} serves one model per server and ${shared} is shared with: ${others.join(', ')}`,
    {
      details: {
        entry: instance.id,
        adapter: adapterId,
        runtime: instance.runtimeId,
        shared: [...others],
      },
      hint: `give it a server of its own: declare a second runtimes: entry with a different port and point models.${instance.id}.runtime at it`,
    },
  );

const toAuthConfig = (entry: RawRuntimeEntry): AuthConfig | undefined => {
  if (!entry.auth) return undefined;
  return { apiKeyEnv: entry.auth.api_key_env, apiKeyFile: entry.auth.api_key_file };
};

/** Every `agents:` role must name a real entry (§12). Surface checks happen in `apply`/`doctor`. */
const checkAgentRoles = (
  agents: RawAgents | undefined,
  models: ReadonlyMap<string, RuntimeInstance>,
): void => {
  if (!agents) return;
  const check = (agent: string, role: string, modelId: string | undefined): void => {
    if (modelId === undefined) return;
    if (!models.has(modelId)) {
      throw cliError(
        'CONFIG_INVALID',
        `agents.${agent}.${role} names unknown model id "${modelId}"`,
        {
          details: { agent, role, model: modelId, known: [...models.keys()] },
          hint: `configured model ids: ${[...models.keys()].join(', ') || '(none)'}`,
        },
      );
    }
  };
  check('claude', 'opus', agents.claude?.opus);
  check('claude', 'sonnet', agents.claude?.sonnet);
  check('claude', 'haiku', agents.claude?.haiku);
  check('codex', 'model', agents.codex?.model);
  check('opencode', 'default', agents.opencode?.default);
};
