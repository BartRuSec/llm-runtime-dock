import * as z from 'zod';
import en from 'zod/v4/locales/en.js';

// Pin the error language explicitly, and note that both halves matter.
//
// `import * as z` rather than `import { z }`: the named binding is an object
// zod builds by re-exporting everything, which esbuild cannot see through, so
// the bundle keeps all 53 locales — 273 kB for languages nothing selects. The
// namespace form tree-shakes, but it drops `en` along with the rest and every
// message degrades to a bare "Invalid input". Registering the one locale costs
// 4 kB and is what `formatZodError` in ./load.ts renders. Adapters inherit it:
// zod's config is global to the module instance, and each of them reaches this
// module through `@llm-runtime-dock/core`.
z.config(en());

/**
 * Structural validation of the YAML file (spec §12). Adapter-specific `options`
 * stay `unknown` here: only the owning adapter knows what they mean (§6).
 */

const authSchema = z
  .object({
    api_key_env: z.string().min(1).optional(),
    api_key_file: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.api_key_env !== undefined || value.api_key_file !== undefined, {
    message: 'auth requires api_key_env or api_key_file',
  });

const surfaceSchema = z.enum(['openai', 'anthropic']);

/** Custom-adapter blocks. Other adapters derive their endpoint from host/port. */
const processStepSchema = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    // Opt-in shell execution. Trusted configuration only; never request-derived (§11).
    shell: z.boolean().optional(),
  })
  .strict();

const processSchema = z
  .object({
    start: processStepSchema,
    stop: processStepSchema.optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    startup_timeout_ms: z.number().int().positive().optional(),
    shutdown_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const urlBlockSchema = z
  .object({ url: z.string().url(), timeout_ms: z.number().int().positive().optional() })
  .strict();

/**
 * One declared runtime: a server this machine can talk to (§12).
 *
 * Everything that describes the *endpoint* lives here; everything that describes
 * a *model* lives in `models:`. That split is what makes two entries on one
 * server structurally unable to disagree about it, which is why no such
 * conflict is representable.
 */
export const runtimeEntrySchema = z
  .object({
    adapter: z.string().min(1),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    /** Server-scoped options only: the keys the adapter names in `serverScopedOptionKeys`. */
    options: z.record(z.string(), z.unknown()).optional(),
    auth: authSchema.optional(),
    surfaces: z.array(surfaceSchema).nonempty().optional(),
    process: processSchema.optional(),
    health: urlBlockSchema.optional(),
    model_discovery: urlBlockSchema.optional(),
    endpoint: urlBlockSchema.optional(),
    /**
     * Whether `lrd probe` may look at this runtime at all (§22). Default `true`.
     *
     * `false` marks a runtime managed by hand: discovery skips it entirely and
     * `--save` never writes its entry or its models. It changes nothing about
     * serving — the gateway starts, stops and proxies to it as before.
     */
    discovery: z.boolean().optional(),
  })
  .strict();

export const modelEntrySchema = z
  .object({
    /** Names a key in `runtimes:`. There is no implicit fallback to an adapter id. */
    runtime: z.string().min(1),
    backend_model: z.string().min(1),
    name: z.string().min(1).optional(),
    /** Model-scoped options only: never a key in the adapter's `serverScopedOptionKeys`. */
    options: z.record(z.string(), z.unknown()).optional(),
    extra_args: z.array(z.string()).optional(),
    /**
     * Never unloaded by a switch (§8): this entry keeps its memory while other
     * entries rotate through the slot.
     *
     * A scheduling flag, not a launch option, so it lives here rather than in an
     * adapter's `optionSpecs` — those double as the argv allowlist, and this one
     * renders no flag at all.
     */
    keep_resident: z.boolean().optional(),
    /**
     * Recorded, never served (§12, §13): omitted from `/v1/models`, refused by
     * resolution, and never written into a coding agent's configuration.
     *
     * For the models a probe finds and a client should never ask for —
     * embeddings, a sidecar a backend uses on its own, or simply one that is
     * installed and not wanted right now. Deleting the entry is not the same
     * thing: the next `probe --save` writes it straight back.
     *
     * A catalogue flag rather than a launch option, so it lives here rather
     * than under `options:` — it renders no flag, and no adapter validates it.
     */
    disabled: z.boolean().optional(),
  })
  .strict();

export const serverSchema = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(8787),
  })
  .strict();

/**
 * `agents:` records which entry plays which role (§23). Values are logical model
 * ids; unknown ids fail validation so a rename is caught by `doctor`.
 */
export const agentsSchema = z
  .object({
    claude: z
      .object({
        opus: z.string().optional(),
        sonnet: z.string().optional(),
        haiku: z.string().optional(),
      })
      .strict()
      .optional(),
    codex: z
      .object({
        model: z.string(),
        reasoning_effort: z.string().optional(),
      })
      .strict()
      .optional(),
    opencode: z.object({ default: z.string() }).strict().optional(),
  })
  .strict();

export const rawConfigSchema = z
  .object({
    server: serverSchema.default({ host: '127.0.0.1', port: 8787 }),
    runtimes: z.record(z.string(), runtimeEntrySchema).default({}),
    models: z.record(z.string(), modelEntrySchema).default({}),
    agents: agentsSchema.optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof rawConfigSchema>;
export type RawModelEntry = z.infer<typeof modelEntrySchema>;
export type RawRuntimeEntry = z.infer<typeof runtimeEntrySchema>;
export type RawAgents = z.infer<typeof agentsSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
