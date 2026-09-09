import * as z from 'zod';
import type { OptionSpec, OptionValidationContext, ReservedArg } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';

/** LM Studio launch options (spec §19). */
export const LM_STUDIO_OPTION_SPECS: Record<string, OptionSpec> = {
  gpu: { flag: '--gpu', description: 'off | max | a ratio between 0 and 1' },
  context_length: { flag: '-c, --context-length' },
  parallel: { flag: '--parallel' },
};

export const LM_STUDIO_RESERVED_ARGS: ReservedArg[] = [
  {
    flags: ['--identifier'],
    optionKeys: ['identifier'],
    reason:
      'the gateway assigns the served identifier, and overriding it breaks identity verification',
    insteadUse: 'the entry key, which becomes the identifier',
  },
  {
    flags: ['--ttl'],
    optionKeys: ['ttl'],
    reason:
      "an idle auto-unload would drop the model behind the gateway's back, leaving its state stale",
    insteadUse: 'nothing — the gateway owns residency through the resident slot',
  },
  {
    flags: ['-p', '--port'],
    optionKeys: ['port'],
    reason: 'core must know the proxy target and the health-check URL',
    insteadUse: "the entry's `port:` field",
  },
  {
    flags: ['--bind'],
    optionKeys: ['bind'],
    reason: 'core must know the proxy target and the health-check URL',
    insteadUse: "the entry's `host:` field",
  },
  {
    flags: ['--api-key', '--api-key-file'],
    optionKeys: ['api_key', 'api_key_file'],
    reason: 'the gateway never generates or injects upstream credentials',
    insteadUse: "the entry's `auth:` block",
  },
];

const gpu = z.union([z.enum(['off', 'max']), z.number().min(0).max(1)]);

const schema = z
  .object({
    gpu: gpu.optional(),
    context_length: z.number().int().positive().optional(),
    parallel: z.number().int().positive().optional(),
  })
  .strict();

export type LmStudioOptions = z.infer<typeof schema>;

export const validateLmStudioOptions = (
  raw: unknown,
  context: OptionValidationContext,
): LmStudioOptions => {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw cliError('RUNTIME_OPTIONS_INVALID', `models.${context.id}.options: ${detail}`, {
      details: { entry: context.id, adapter: 'lm-studio' },
    });
  }
  return result.data;
};

/** Render validated options as documented `lms load` flags. */
export const renderLmStudioArgs = (options: LmStudioOptions): string[] => {
  const args: string[] = [];
  if (options.gpu !== undefined) args.push('--gpu', String(options.gpu));
  if (options.context_length !== undefined)
    args.push('--context-length', String(options.context_length));
  if (options.parallel !== undefined) args.push('--parallel', String(options.parallel));
  return args;
};
