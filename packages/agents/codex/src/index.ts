import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { AgentIntegration, ApplyPlan, RenderedConfig } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';

/**
 * Codex integration (spec §23).
 *
 * Codex speaks OpenAI and wants `base_url` with the `/v1` suffix. Its config is
 * TOML; a round-trip cannot preserve comments, so apply warns before writing
 * rather than reformatting silently.
 */

const PROVIDER_ID = 'llm-runtime-dock';

export interface CodexOptions {
  readonly configDir?: string;
}

export const createCodexIntegration = (options: CodexOptions = {}): AgentIntegration => {
  const id = 'codex';
  const displayName = 'Codex';
  const surface = 'openai' as const;
  /** `env_key` names the variable holding the credential, never its value. */
  const supportsSecretReference = true;
  const roles = ['model'] as const;
  // `model_provider` without `model` points Codex at a provider and no model.
  const requiresRoleMapping = true;
  const configDir = options.configDir ?? join(homedir(), '.codex');

  const configPath = (): string => {
    return join(configDir, 'config.toml');
  };

  const isInstalled = async (): Promise<boolean> => {
    return existsSync(configDir);
  };

  const render = async (plan: ApplyPlan): Promise<RenderedConfig> => {
    const path = configPath();
    const warnings: string[] = [];

    let existing: Record<string, unknown> = {};
    if (plan.existing !== null && plan.existing.trim() !== '') {
      try {
        existing = parseToml(plan.existing) as Record<string, unknown>;
      } catch (cause) {
        throw cliError(
          'AGENT_CONFIG_UNREADABLE',
          `${path} could not be parsed: ${(cause as Error).message}`,
          {
            details: { agent: id, path },
            cause,
            hint: 'fix the file by hand; nothing was written',
          },
        );
      }
      if (/^\s*#/m.test(plan.existing)) {
        warnings.push(`${path} contains comments, which a TOML rewrite cannot preserve`);
      }
    }

    const model = plan.roles.model;
    const providers = isRecord(existing.model_providers) ? { ...existing.model_providers } : {};

    const provider: Record<string, unknown> = {
      name: PROVIDER_ID,
      base_url: `${plan.gatewayBaseUrl}/v1`,
    };
    const mapped = plan.models.find((entry) => entry.id === model);
    if (mapped?.apiKeyEnv) {
      // A variable name, not a value (§23).
      provider.env_key = mapped.apiKeyEnv;
    }
    providers[PROVIDER_ID] = provider;

    // Merge: unrelated providers and top-level settings are preserved. Key order
    // is insertion-ordered, so a second run reproduces the file byte for byte.
    const merged: Record<string, unknown> = { ...existing };
    if (model !== undefined) merged.model = model;
    merged.model_provider = PROVIDER_ID;
    if (plan.settings.reasoning_effort)
      merged.model_reasoning_effort = plan.settings.reasoning_effort;
    merged.model_providers = providers;

    return { path, content: `${stringifyToml(merged)}\n`, warnings };
  };

  return {
    id,
    displayName,
    surface,
    supportsSecretReference,
    roles,
    requiresRoleMapping,
    configPath,
    isInstalled,
    render,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};
