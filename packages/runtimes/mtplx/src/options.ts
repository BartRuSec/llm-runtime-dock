import * as z from 'zod';
import type { OptionSpec, OptionValidationContext, ReservedArg } from '@llm-runtime-dock/core';
import { cliError, expandHome } from '@llm-runtime-dock/core';

/**
 * MTPLX launch options (spec §18).
 *
 * Every named option maps to exactly one documented `mtplx serve` flag. MTPLX
 * exposes many more; they are reachable through `extra_args` and deliberately
 * not enumerated here — this list is the supported, validated surface.
 */
export const MTPLX_OPTION_SPECS: Record<string, OptionSpec> = {
  reasoning: { flag: '--reasoning', description: 'auto | on | off' },
  reasoning_effort: {
    flag: '--reasoning-effort',
    description: 'auto | low | medium | high | xhigh',
  },
  profile: {
    flag: '--profile',
    description: 'stable | performance-cold | sustained | turbo | exact | max-diagnostic',
  },
  depth: { flag: '--depth' },
  generation_mode: { flag: '--generation-mode', description: 'mtp | ar | auto' },
  context_window: { flag: '--context-window' },
  max_tokens: { flag: '--max-tokens' },
  batching_preset: {
    flag: '--batching-preset',
    description: 'solo | latency | agent | throughput',
  },
  scheduler_mode: { flag: '--scheduler-mode' },
  tool_prompt_mode: {
    flag: '--tool-prompt-mode',
    description: 'hybrid | native — how MTPLX renders the tool prompt',
  },
  chat_template_profile: {
    flag: '--chat-template-profile',
    description: 'local_qwen36 | froggeric_v19 | froggeric_v21_3 | tokenizer',
  },
  chat_template_path: {
    flag: '--chat-template-path',
    description: 'explicit chat_template.jinja path',
  },
  reasoning_parser: {
    flag: '--reasoning-parser',
    description: 'qwen3 | step3p5 | gemma4 | poolside_v1 | none',
  },
  preserve_thinking: {
    flag: '--preserve-thinking',
    description: 'auto | on | off | scoped',
  },
  agent_rewrites: {
    flag: '--agent-rewrites',
    description: 'on | off — MTPLX transcript rewriting; unset is its own passthrough default',
  },
  stats_footer: {
    flag: '--no-stats-footer',
    description: 'false appends nothing to the response text; defaults to false',
  },
  stream_interval: {
    flag: '--stream-interval',
    description: 'committed-token batch size per chat SSE chunk',
  },
  defaults: {
    // Selects whether the launch-defaults table applies at all, so it renders
    // nothing itself and owns no flag the extra_args check could collide with.
    flag: '(dock launch defaults)',
    rendersNoFlag: true,
    description: 'false leaves every MTPLX default untouched',
  },
};

export const MTPLX_RESERVED_ARGS: ReservedArg[] = [
  {
    flags: ['--host'],
    optionKeys: ['host'],
    reason: 'core must know the proxy target and the health-check URL',
    insteadUse: "the entry's `host:` field",
  },
  {
    flags: ['-p', '--port'],
    optionKeys: ['port'],
    reason: 'core must know the proxy target and the health-check URL',
    insteadUse: "the entry's `port:` field",
  },
  {
    flags: ['--model'],
    optionKeys: ['model'],
    reason: 'overriding it silently breaks model identity verification',
    insteadUse: "the entry's `backend_model:` field",
  },
  {
    flags: ['--model-id'],
    optionKeys: ['model_id'],
    reason: 'the served id must stay the loaded artifact identity, or identity verification drifts',
    insteadUse: "the entry's `backend_model:` field",
  },
  {
    flags: ['--api-key', '--api-key-file'],
    optionKeys: ['api_key', 'api_key_file'],
    reason: 'the gateway never generates or injects upstream credentials',
    insteadUse: "the entry's `auth:` block",
  },
];

const reasoning = z.enum(['auto', 'on', 'off']);
const reasoningEffort = z.enum(['auto', 'low', 'medium', 'high', 'xhigh']);
const profile = z.enum([
  'stable',
  'performance-cold',
  'sustained',
  'turbo',
  'exact',
  'max-diagnostic',
]);
const generationMode = z.enum(['mtp', 'ar', 'auto']);
const batchingPreset = z.enum(['solo', 'latency', 'agent', 'throughput']);
const toolPromptMode = z.enum(['hybrid', 'native']);
const chatTemplateProfile = z.enum([
  'local_qwen36',
  'froggeric_v19',
  'froggeric_v21_3',
  'tokenizer',
]);
const reasoningParser = z.enum(['qwen3', 'step3p5', 'gemma4', 'poolside_v1', 'none']);
const preserveThinking = z.enum(['auto', 'on', 'off', 'scoped']);
const agentRewrites = z.enum(['on', 'off']);

const schema = z
  .object({
    reasoning: reasoning.optional(),
    reasoning_effort: reasoningEffort.optional(),
    profile: profile.optional(),
    depth: z.number().int().positive().optional(),
    generation_mode: generationMode.optional(),
    context_window: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    batching_preset: batchingPreset.optional(),
    scheduler_mode: z.string().min(1).optional(),
    tool_prompt_mode: toolPromptMode.optional(),
    chat_template_profile: chatTemplateProfile.optional(),
    chat_template_path: z.string().min(1).optional(),
    reasoning_parser: reasoningParser.optional(),
    preserve_thinking: preserveThinking.optional(),
    agent_rewrites: agentRewrites.optional(),
    stats_footer: z.boolean().optional(),
    stream_interval: z.number().int().positive().optional(),
    defaults: z.boolean().optional(),
  })
  .strict();

export type MtplxOptions = z.infer<typeof schema>;

/**
 * Launch defaults the dock applies when an entry does not set them (§18).
 *
 * The selection rule, which is the whole reason this table stays short: a
 * default may only be **model-independent**. An entry names any `backend_model`
 * and this table is written without knowing which, so anything whose correct
 * value follows from the weights, the chat template or the trained contract —
 * `--tool-prompt-mode`, `--chat-template-profile`, `--reasoning-parser`,
 * `--preserve-thinking`, `--profile`, `--depth`, `--context-window` — stays with
 * MTPLX's own per-model resolution, which can see the model while this cannot.
 *
 * That rule is why there are no tool-calling defaults here: every MTPLX flag
 * that governs tool rendering is model-dependent. They are configurable per
 * entry instead.
 *
 * `--no-stats-footer` qualifies because the footer is MTPLX-generated text
 * appended to any model's output, and an agent reading it as part of the
 * assistant message is wrong regardless of which model produced it.
 */
export const MTPLX_DEFAULT_OPTIONS: Readonly<Partial<MtplxOptions>> = {
  stats_footer: false,
};

export const validateMtplxOptions = (
  raw: unknown,
  context: OptionValidationContext,
): MtplxOptions => {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    // A YAML `on:`/`off:` read as a boolean lands here rather than being coerced (§12).
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw cliError('RUNTIME_OPTIONS_INVALID', `models.${context.id}.options: ${detail}`, {
      details: { entry: context.id, adapter: 'mtplx' },
      hint: 'quote on/off/yes/no values so YAML does not read them as booleans',
    });
  }
  return result.data;
};

/**
 * The options actually rendered: the defaults table, overridden by whatever the
 * entry set. `defaults: false` opts out of the table entirely and leaves MTPLX
 * with its own defaults.
 */
export const effectiveMtplxOptions = (options: MtplxOptions): MtplxOptions => {
  if (options.defaults === false) return options;
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) set[key] = value;
  }
  return { ...MTPLX_DEFAULT_OPTIONS, ...set } as MtplxOptions;
};

/** Render validated options as documented `mtplx serve` flags. */
export const renderMtplxArgs = (options: MtplxOptions): string[] => {
  const effective = effectiveMtplxOptions(options);
  const args: string[] = [];
  const push = (flag: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    args.push(flag, String(value));
  };
  push('--reasoning', effective.reasoning);
  push('--reasoning-effort', effective.reasoning_effort);
  push('--profile', effective.profile);
  push('--depth', effective.depth);
  push('--generation-mode', effective.generation_mode);
  push('--context-window', effective.context_window);
  push('--max-tokens', effective.max_tokens);
  push('--batching-preset', effective.batching_preset);
  push('--scheduler-mode', effective.scheduler_mode);
  push('--tool-prompt-mode', effective.tool_prompt_mode);
  push('--chat-template-profile', effective.chat_template_profile);
  // A `~/` or `~\` path is expanded here rather than in the schema, so the
  // validated config keeps what the user wrote (§12).
  push(
    '--chat-template-path',
    effective.chat_template_path === undefined
      ? undefined
      : expandHome(effective.chat_template_path),
  );
  push('--reasoning-parser', effective.reasoning_parser);
  push('--preserve-thinking', effective.preserve_thinking);
  push('--agent-rewrites', effective.agent_rewrites);
  push('--stream-interval', effective.stream_interval);
  // The only boolean-as-flag: MTPLX has `--no-stats-footer` and no positive
  // spelling, so `true` means "say nothing and let MTPLX append its footer".
  if (effective.stats_footer === false) args.push('--no-stats-footer');
  return args;
};
