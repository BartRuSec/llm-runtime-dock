import * as z from 'zod';
import type { OptionSpec, OptionValidationContext, ReservedArg } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';

/**
 * oMLX options (spec §20).
 *
 * In attach mode there are no per-entry options: `backend_model` is the id oMLX
 * discovered, and everything about how that model runs lives in oMLX's own
 * configuration. The options below are server-scoped and only take effect when
 * the gateway spawns the server.
 */
export const OMLX_OPTION_SPECS: Record<string, OptionSpec> = {
  model_dir: { flag: '--model-dir' },
  memory_guard: { flag: '--memory-guard', description: 'off | safe | balanced | aggressive' },
  max_concurrent_requests: { flag: '--max-concurrent-requests' },
};

export const OMLX_SERVER_SCOPED_OPTION_KEYS = [
  'model_dir',
  'memory_guard',
  'max_concurrent_requests',
] as const;

export const OMLX_RESERVED_ARGS: ReservedArg[] = [
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
    flags: ['--api-key', '--api-key-file'],
    optionKeys: ['api_key', 'api_key_file'],
    reason: 'the gateway never generates or injects upstream credentials',
    insteadUse: "the entry's `auth:` block",
  },
];

const schema = z
  .object({
    model_dir: z.string().min(1).optional(),
    memory_guard: z.enum(['off', 'safe', 'balanced', 'aggressive']).optional(),
    max_concurrent_requests: z.number().int().positive().optional(),
  })
  .strict();

export type OmlxOptions = z.infer<typeof schema>;

export const validateOmlxOptions = (
  raw: unknown,
  context: OptionValidationContext,
): OmlxOptions => {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw cliError('RUNTIME_OPTIONS_INVALID', `models.${context.id}.options: ${detail}`, {
      details: { entry: context.id, adapter: 'omlx' },
    });
  }
  return result.data;
};

/** Render server-scoped options as documented `omlx serve` flags. */
export const renderOmlxArgs = (options: OmlxOptions): string[] => {
  const args: string[] = [];
  if (options.model_dir) args.push('--model-dir', options.model_dir);
  if (options.memory_guard) args.push('--memory-guard', options.memory_guard);
  if (options.max_concurrent_requests !== undefined) {
    args.push('--max-concurrent-requests', String(options.max_concurrent_requests));
  }
  return args;
};
