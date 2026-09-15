import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { JSONPath, ParseError } from 'jsonc-parser';
import type { AgentIntegration, ApplyPlan, RenderedConfig } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';

/**
 * OpenCode integration (spec §23).
 *
 * OpenCode speaks OpenAI and wants `baseURL` with the `/v1` suffix. The file may
 * be `opencode.json` or a hand-maintained `opencode.jsonc` with comments; the
 * one that exists is the one written back, and edits are applied in place so
 * comments and key order survive.
 *
 * Every edit names a leaf, never the provider block: the gateway owns `npm`,
 * `name`, `options.baseURL`, `options.apiKey` and each model's `name`/`limit`,
 * and nothing else under its own block is its business. Writing the block whole
 * would delete a hand-added `variants`, a per-model `options`, or a comment
 * inside it — the clobbering §23 exists to prevent.
 */

const PROVIDER_ID = 'llm-runtime-dock';
const PROVIDER_NAME = 'LLM Runtime Dock';
/** What apply wrote itself, as opposed to a literal the user typed. */
const ENV_REFERENCE = /^\{env:[^}]+\}$/;

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

  /** One key, in place. `undefined` deletes it; missing parents are created. */
  const setPath = (content: string, path: JSONPath, value: unknown): string => {
    let next = content;
    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    for (const edit of modify(next, path, value, formatting)) {
      next = applyEdits(next, [edit]);
    }
    return next;
  };

  const render = async (plan: ApplyPlan): Promise<RenderedConfig> => {
    const path = configPath();
    const source = plan.existing ?? '{}';
    const warnings: string[] = [];

    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0];
      throw cliError(
        'AGENT_CONFIG_UNREADABLE',
        `${path} could not be parsed (${first ? printParseErrorCode(first.error) : 'unknown error'} at offset ${first?.offset ?? 0})`,
        { details: { agent: id, path }, hint: 'fix the file by hand; nothing was written' },
      );
    }

    const previous = providerBlock(parsed);
    const defaultModel = plan.roles.default;
    const base: JSONPath = ['provider', PROVIDER_ID];

    let content = source.trim() === '' ? '{}' : source;
    content = setPath(content, [...base, 'npm'], '@ai-sdk/openai-compatible');
    content = setPath(content, [...base, 'name'], PROVIDER_NAME);
    content = setPath(content, [...base, 'options', 'baseURL'], `${plan.gatewayBaseUrl}/v1`);

    const secretModel = plan.models.find((model) => model.apiKeyEnv !== undefined);
    const existingKey = previousApiKey(previous);
    if (secretModel?.apiKeyEnv) {
      // An environment-variable reference, never a resolved value (§23).
      content = setPath(content, [...base, 'options', 'apiKey'], `{env:${secretModel.apiKeyEnv}}`);
    } else if (typeof existingKey === 'string' && ENV_REFERENCE.test(existingKey)) {
      // A reference apply wrote before and no entry needs any more is stale, so
      // it goes; a literal the user typed is theirs and stays.
      content = setPath(content, [...base, 'options', 'apiKey'], undefined);
    }

    for (const model of plan.models) {
      content = setPath(content, [...base, 'models', model.id, 'name'], model.name);
      // A limit the gateway cannot state is left as it is rather than guessed
      // or deleted — a hand-written one is the user's own knowledge (§23).
      if (model.contextLimit !== undefined) {
        content = setPath(
          content,
          [...base, 'models', model.id, 'limit', 'context'],
          model.contextLimit,
        );
      }
      if (model.outputLimit !== undefined) {
        content = setPath(
          content,
          [...base, 'models', model.id, 'limit', 'output'],
          model.outputLimit,
        );
      }
    }

    // The one deletion apply still makes, and it is inside its own block: an id
    // the gateway no longer serves would have OpenCode offer a model that
    // answers 404 (§12).
    const served = new Set(plan.models.map((model) => model.id));
    for (const stale of Object.keys(previousModels(previous))) {
      if (!served.has(stale)) content = setPath(content, [...base, 'models', stale], undefined);
    }

    if (defaultModel) {
      content = setPath(content, ['model'], `${PROVIDER_ID}/${defaultModel}`);
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const providerBlock = (parsed: unknown): Record<string, unknown> => {
  if (!isRecord(parsed) || !isRecord(parsed.provider)) return {};
  const block = parsed.provider[PROVIDER_ID];
  return isRecord(block) ? block : {};
};

const previousModels = (block: Record<string, unknown>): Record<string, unknown> => {
  return isRecord(block.models) ? block.models : {};
};

const previousApiKey = (block: Record<string, unknown>): unknown => {
  return isRecord(block.options) ? block.options.apiKey : undefined;
};
