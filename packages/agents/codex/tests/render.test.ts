import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import type { ApplyPlan } from '@llm-runtime-dock/core';
import { createCodexIntegration } from '../src/index.js';

/** Codex's config.toml (spec §23). `render` is pure. */

const agent = createCodexIntegration({ configDir: join(tmpdir(), 'codex-test') });

const plan = (existing: string | null, overrides: Partial<ApplyPlan> = {}): ApplyPlan => ({
  gatewayBaseUrl: 'http://127.0.0.1:8787',
  models: [
    {
      id: 'coding-quality',
      name: 'Qwen3.8-27B',
      contextLimit: undefined,
      outputLimit: undefined,
      apiKeyEnv: undefined,
    },
  ],
  roles: { model: 'coding-quality' },
  settings: { reasoning_effort: 'high' },
  existing,
  configPath: agent.configPath(),
  ...overrides,
});

describe('codex integration', () => {
  it('speaks OpenAI and can reference a credential by variable', () => {
    expect(agent.surface).toBe('openai');
    expect(agent.supportsSecretReference).toBe(true);
    expect([...agent.roles]).toEqual(['model']);
  });

  it('writes the provider table and selects it', async () => {
    const { content } = await agent.render(plan(null));
    const written = parseToml(content) as Record<string, any>;
    expect(written.model).toBe('coding-quality');
    expect(written.model_provider).toBe('llm-runtime-dock');
    expect(written.model_providers['llm-runtime-dock'].base_url).toBe('http://127.0.0.1:8787/v1');
    expect(written.model_reasoning_effort).toBe('high');
  });

  it('merges, preserving unrelated tables and settings', async () => {
    const existing = `approval_policy = "on-request"

[model_providers.other]
name = "other"
base_url = "http://127.0.0.1:9999/v1"
`;
    const { content } = await agent.render(plan(existing));
    const written = parseToml(content) as Record<string, any>;
    expect(written.approval_policy).toBe('on-request');
    expect(written.model_providers.other.base_url).toBe('http://127.0.0.1:9999/v1');
    expect(written.model_providers['llm-runtime-dock']).toBeDefined();
  });

  it('writes env_key rather than a resolved secret', async () => {
    const { content } = await agent.render(
      plan(null, {
        models: [
          {
            id: 'coding-quality',
            name: 'Qwen3.8-27B',
            contextLimit: undefined,
            outputLimit: undefined,
            apiKeyEnv: 'MY_KEY',
          },
        ],
      }),
    );
    expect(content).toContain('env_key = "MY_KEY"');
    expect(content).not.toContain('secret');
  });

  it('warns before a rewrite drops comments', async () => {
    // TOML round-tripping cannot preserve them, so say so rather than
    // reformatting the user's file silently.
    const { warnings } = await agent.render(
      plan('# a comment I wrote\napproval_policy = "never"\n'),
    );
    expect(warnings.join(' ')).toContain('comments');
  });

  it('is idempotent', async () => {
    const first = await agent.render(plan(null));
    const second = await agent.render(plan(first.content));
    expect(second.content).toBe(first.content);
  });

  it('reports an unparseable config rather than overwriting it', async () => {
    await expect(agent.render(plan('this is = = not toml'))).rejects.toMatchObject({
      code: 'AGENT_CONFIG_UNREADABLE',
    });
  });
});
