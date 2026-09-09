import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import type { AgentIntegration, ApplyPlan, RenderedConfig } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';

/**
 * OpenCode integration (spec §23).
 *
 * OpenCode speaks OpenAI and wants `baseURL` with the `/v1` suffix. The file may
 * be `opencode.json` or a hand-maintained `opencode.jsonc` with comments; the
 * one that exists is the one written back, and edits are applied in place so
 * comments and key order survive.
 */

const PROVIDER_ID = 'llm-runtime-dock';
const PROVIDER_NAME = 'LLM Runtime Dock';

export interface OpenCodeOptions {
  /** Override the config directory. Used by tests. */
  readonly configDir?: string;
}

export const createOpenCodeIntegration = (options: OpenCodeOptions = {}): AgentIntegration => {
  const id = 'opencode';
  const displayName = 'OpenCode';
  const surface = 'openai' as const;
  /** OpenCode reads `{env:VAR}` in provider options, so a reference is expressible. */
  const supportsSecretReference = true;
  const roles = ['default'] as const;
  // The provider block registers every configured model on its own, so applying
  // without a role mapping is still useful — and leaves the user's own default
  // model selection untouched.
  const requiresRoleMapping = false;
  const configDir = options.configDir ?? join(homedir(), '.config', 'opencode');

  const configPath = (): string => {
    const jsonc = join(configDir, 'opencode.jsonc');
    return existsSync(jsonc) ? jsonc : join(configDir, 'opencode.json');
  };

  const isInstalled = async (): Promise<boolean> => {
    return existsSync(configDir);
  };

  const render = async (plan: ApplyPlan): Promise<RenderedConfig> => {
    const path = configPath();
    const source = plan.existing ?? '{}';
    const warnings: string[] = [];

    const errors: ParseError[] = [];
    parseJsonc(source, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0];
      throw cliError(
        'AGENT_CONFIG_UNREADABLE',
        `${path} could not be parsed (${first ? printParseErrorCode(first.error) : 'unknown error'} at offset ${first?.offset ?? 0})`,
        { details: { agent: id, path }, hint: 'fix the file by hand; nothing was written' },
      );
    }

    const defaultModel = plan.roles.default;
    const models: Record<string, unknown> = {};
    for (const model of plan.models) {
      const limit: Record<string, number> = {};
      // A limit the gateway cannot state is omitted rather than guessed (§23).
      if (model.contextLimit !== undefined) limit.context = model.contextLimit;
      if (model.outputLimit !== undefined) limit.output = model.outputLimit;
      models[model.id] = {
        name: model.name,
        ...(Object.keys(limit).length > 0 ? { limit } : {}),
      };
    }

    const secretModel = plan.models.find((model) => model.apiKeyEnv !== undefined);
    const providerOptions: Record<string, unknown> = { baseURL: `${plan.gatewayBaseUrl}/v1` };
    if (secretModel?.apiKeyEnv) {
      // An environment-variable reference, never a resolved value (§23).
      providerOptions.apiKey = `{env:${secretModel.apiKeyEnv}}`;
    }

    const provider = {
      npm: '@ai-sdk/openai-compatible',
      name: PROVIDER_NAME,
      options: providerOptions,
      models,
    };

    // `modify`/`applyEdits` rewrite only the touched paths, so every unrelated
    // key, provider block and comment in the file survives.
    let content = source.trim() === '' ? '{}' : source;
    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    for (const edit of modify(content, ['provider', PROVIDER_ID], provider, formatting)) {
      content = applyEdits(content, [edit]);
    }
    if (defaultModel) {
      for (const edit of modify(content, ['model'], `${PROVIDER_ID}/${defaultModel}`, formatting)) {
        content = applyEdits(content, [edit]);
      }
    }
    if (!content.endsWith('\n')) content += '\n';

    return { path, content, warnings };
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
