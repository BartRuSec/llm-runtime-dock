import * as z from 'zod';
import type { OptionSpec, OptionValidationContext, ReservedArg } from '@llm-runtime-dock/core';
import { cliError, expandHome } from '@llm-runtime-dock/core';

/**
 * `ollama serve` accepts no flags — `-h` and nothing else. Every knob it
 * documents is an environment variable, so `flag` here names the variable an
 * option renders rather than a command-line switch. That is safe because core
 * only ever treats a `flag` as a flag when it begins with `-`: `curatedFlags`
 * skips these, so they can never collide with `extra_args` (§7, §12).
 */
export const OLLAMA_OPTION_SPECS: Record<string, OptionSpec> = {
  model_dir: { flag: 'OLLAMA_MODELS' },
  context_length: { flag: 'OLLAMA_CONTEXT_LENGTH' },
  max_loaded_models: { flag: 'OLLAMA_MAX_LOADED_MODELS' },
  num_parallel: { flag: 'OLLAMA_NUM_PARALLEL' },
  flash_attention: { flag: 'OLLAMA_FLASH_ATTENTION' },
  kv_cache_type: { flag: 'OLLAMA_KV_CACHE_TYPE' },
};

/** Every option configures the server, so all of them belong on `runtimes:` (§12). */
export const OLLAMA_SERVER_SCOPED_OPTION_KEYS = [
  'model_dir',
  'context_length',
  'max_loaded_models',
  'num_parallel',
  'flash_attention',
  'kv_cache_type',
] as const;

/**
 * Reserved by the gateway (§12).
 *
 * Only the `optionKeys` half of each entry can fire: `checkExtraArgs` inspects
 * arguments beginning with `-`, and these are environment variables. The
 * `flags` spellings are kept because they are what the error message quotes,
 * and because that is where a reader looks for the reserved name.
 */
export const OLLAMA_RESERVED_ARGS: ReservedArg[] = [
  {
    flags: ['OLLAMA_HOST'],
    optionKeys: ['host', 'port'],
    reason: 'core must know the proxy target and health-check URL',
    insteadUse: "the entry's `host:`/`port:` fields",
  },
  {
    flags: ['OLLAMA_KEEP_ALIVE'],
    optionKeys: ['keep_alive'],
    reason: 'the gateway controls model residency explicitly',
    insteadUse: "the entry's `keep_resident:` field",
  },
];

const schema = z
  .object({
    model_dir: z.string().min(1).optional(),
    context_length: z.number().int().positive().optional(),
    max_loaded_models: z.number().int().positive().optional(),
    num_parallel: z.number().int().positive().optional(),
    flash_attention: z.boolean().optional(),
    kv_cache_type: z.string().min(1).optional(),
  })
  .strict();

export type OllamaOptions = z.infer<typeof schema>;

export const validateOllamaOptions = (
  raw: unknown,
  context: OptionValidationContext,
): OllamaOptions => {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw cliError('RUNTIME_OPTIONS_INVALID', `models.${context.id}.options: ${detail}`, {
      details: { entry: context.id, adapter: 'ollama' },
    });
  }
  // `extra_args` is the escape hatch for flags an adapter does not name, and
  // `ollama serve` has none to reach: anything put here would be handed to it
  // as an operand and make it fail to parse. Refusing at load time is the whole
  // point of validating here rather than discovering it at the first switch.
  const extraArgs = context.entry.extra_args;
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    throw cliError(
      'RUNTIME_OPTIONS_INVALID',
      `models.${context.id}.extra_args is not supported: \`ollama serve\` takes no flags`,
      {
        details: { entry: context.id, adapter: 'ollama' },
        hint: `Ollama is configured through the environment; use options: on runtimes.${context.runtimeId} — known keys: ${OLLAMA_SERVER_SCOPED_OPTION_KEYS.join(', ')}`,
      },
    );
  }
  // Ollama evicts to stay within `OLLAMA_MAX_LOADED_MODELS`, so a limit of 1
  // would unload the kept model the moment a sibling is acquired — the flag
  // undone by the server itself (§8).
  if (
    context.entry.keep_resident === true &&
    result.data.max_loaded_models !== undefined &&
    result.data.max_loaded_models < 2
  ) {
    throw cliError(
      'RUNTIME_OPTIONS_INVALID',
      `models.${context.id}.options.max_loaded_models must be at least 2 when keep_resident is true`,
      { details: { entry: context.id, adapter: 'ollama', option: 'max_loaded_models' } },
    );
  }
  return result.data;
};

/** Curated options as `ollama serve`'s own environment variables (§7). */
export const renderOllamaEnv = (options: OllamaOptions): Record<string, string> => {
  const env: Record<string, string> = {};
  if (options.model_dir) env.OLLAMA_MODELS = expandHome(options.model_dir);
  if (options.context_length !== undefined) {
    env.OLLAMA_CONTEXT_LENGTH = String(options.context_length);
  }
  if (options.max_loaded_models !== undefined) {
    env.OLLAMA_MAX_LOADED_MODELS = String(options.max_loaded_models);
  }
  if (options.num_parallel !== undefined) env.OLLAMA_NUM_PARALLEL = String(options.num_parallel);
  if (options.flash_attention !== undefined) {
    env.OLLAMA_FLASH_ATTENTION = String(options.flash_attention);
  }
  if (options.kv_cache_type) env.OLLAMA_KV_CACHE_TYPE = options.kv_cache_type;
  return env;
};
