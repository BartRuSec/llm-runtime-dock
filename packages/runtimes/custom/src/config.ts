import * as z from 'zod';
import type { OptionValidationContext } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';

/**
 * Custom adapter configuration (spec §11).
 *
 * The user owns the whole argv here, so the reserved-argument rules of §12 do
 * not apply to `process.start.command`. In exchange, the command and the
 * declared health/discovery/endpoint URLs must agree — `doctor` checks that.
 */

const step = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    /**
     * Opt-in shell execution. Trusted configuration only: nothing derived from
     * an HTTP request ever reaches a command (§11, §28).
     */
    shell: z.boolean().optional(),
  })
  .strict();

const urlBlock = z
  .object({ url: z.string().url(), timeout_ms: z.number().int().positive().optional() })
  .strict();

export const customEntrySchema = z
  .object({
    process: z
      .object({
        start: step,
        stop: step.optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        startup_timeout_ms: z.number().int().positive().optional(),
        shutdown_timeout_ms: z.number().int().positive().optional(),
      })
      .strict(),
    health: urlBlock,
    model_discovery: urlBlock,
    endpoint: urlBlock,
    /**
     * Nothing about a user-defined command implies an Anthropic endpoint, so
     * serving one is an explicit opt-in (§11).
     */
    surfaces: z
      .array(z.enum(['openai', 'anthropic']))
      .nonempty()
      .optional(),
  })
  .passthrough();

export type CustomEntry = z.infer<typeof customEntrySchema>;

/**
 * The custom adapter has no curated `options:` at all: everything runtime-
 * specific lives in the entry's own `process`/`health`/`endpoint` blocks.
 */
export const validateCustomOptions = (
  raw: unknown,
  context: OptionValidationContext,
): CustomEntry => {
  if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) {
    throw cliError(
      'RUNTIME_OPTIONS_INVALID',
      `runtimes.${context.runtimeId}.options is not used by the custom adapter`,
      {
        details: { entry: context.id, adapter: 'custom' },
        hint: 'put runtime flags directly into process.start.command',
      },
    );
  }
  const result = customEntrySchema.safeParse(context.runtimeEntry);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw cliError('CONFIG_INVALID', `runtimes.${context.runtimeId}: ${detail}`, {
      details: { entry: context.id, adapter: 'custom' },
      hint: 'the custom adapter requires process.start.command, health.url, model_discovery.url and endpoint.url',
    });
  }
  return result.data;
};

/**
 * Do the declared URLs agree with each other? Reported by `doctor` (§11).
 * A command that binds a different port than `endpoint.url` names would proxy
 * to nothing, which is exactly the failure §17 exists to prevent.
 */
export const checkUrlAgreement = (entry: CustomEntry): string[] => {
  const warnings: string[] = [];
  const origins = new Set(
    [entry.health.url, entry.model_discovery.url, entry.endpoint.url].map(
      (url) => new URL(url).origin,
    ),
  );
  if (origins.size > 1) {
    warnings.push(
      `health, model_discovery and endpoint point at different origins (${[...origins].join(', ')})`,
    );
  }
  const endpointOrigin = new URL(entry.endpoint.url);
  const argv = entry.process.start.command;
  const portIndex = argv.findIndex((arg) => arg === '--port' || arg === '-p');
  const declaredPort = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  if (declaredPort !== undefined && endpointOrigin.port && declaredPort !== endpointOrigin.port) {
    warnings.push(
      `process.start.command passes --port ${declaredPort} but endpoint.url is ${entry.endpoint.url}`,
    );
  }
  return warnings;
};
