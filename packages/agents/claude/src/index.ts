import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentIntegration, ApplyPlan, RenderedConfig } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';

/**
 * Claude Code integration (spec §23).
 *
 * Claude Code speaks Anthropic and appends `/v1/messages` itself, so its base
 * URL carries no `/v1` suffix — that difference is load-bearing and is not
 * normalized away. It has no provider concept: roles *are* the model selection,
 * which is why `agents.claude` names opus/sonnet/haiku.
 */

const ROLE_ENV: Record<string, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

export interface ClaudeOptions {
  readonly configDir?: string;
}

export const createClaudeIntegration = (options: ClaudeOptions = {}): AgentIntegration => {
  const id = 'claude';
  const displayName = 'Claude Code';
  const surface = 'anthropic' as const;
  /**
   * Values in the `env` block of settings.json are literal strings that Claude
   * Code exports verbatim; there is no indirection syntax. So a credential
   * cannot be referenced, and apply refuses rather than inlining one (§23).
   */
  const supportsSecretReference = false;
  const roles = ['opus', 'sonnet', 'haiku'] as const;
  // No provider concept: the roles are the model selection, so a mapping is the
  // whole point of applying.
  const requiresRoleMapping = true;
  const configDir = options.configDir ?? join(homedir(), '.claude');

  const configPath = (): string => {
    return join(configDir, 'settings.json');
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
        const parsed: unknown = JSON.parse(plan.existing);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('settings.json is not a JSON object');
        }
        existing = parsed as Record<string, unknown>;
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
    }

    const previousEnv = isRecord(existing.env) ? existing.env : {};
    // Merge: every key the gateway does not own survives untouched.
    const env: Record<string, unknown> = { ...previousEnv };
    env.ANTHROPIC_BASE_URL = plan.gatewayBaseUrl;
    // The gateway listens on loopback without authentication, so the agent needs
    // no credential. An empty string stops Claude Code prompting for one.
    if (typeof env.ANTHROPIC_API_KEY !== 'string') env.ANTHROPIC_API_KEY = '';
    for (const [role, modelId] of Object.entries(plan.roles)) {
      const key = ROLE_ENV[role];
      if (key) env[key] = modelId;
    }

    const merged: Record<string, unknown> = { ...existing, env };
    // No comment warning here: settings.json is strict JSON, so a file with
    // comments fails to parse above and is reported as unreadable rather than
    // silently reformatted (§23).
    return { path, content: `${JSON.stringify(merged, null, 2)}\n`, warnings };
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
