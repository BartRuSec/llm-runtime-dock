import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplyPlan } from '@llm-runtime-dock/core';
import { createOpenCodeIntegration } from '../src/index.js';

/** OpenCode's provider block (spec §23). `render` is pure. */

const agent = createOpenCodeIntegration({ configDir: join(tmpdir(), 'opencode-test') });

const plan = (existing: string | null, overrides: Partial<ApplyPlan> = {}): ApplyPlan => ({
  gatewayBaseUrl: 'http://127.0.0.1:8787',
  models: [
    {
      id: 'coding-quality',
      name: 'Qwen3.8-27B',
      contextLimit: 131072,
      outputLimit: 32768,
      apiKeyEnv: undefined,
    },
    {
      id: 'coding-fast',
      name: 'Qwen3.6-35B',
      contextLimit: undefined,
      outputLimit: undefined,
      apiKeyEnv: undefined,
    },
  ],
  roles: { default: 'coding-quality' },
  settings: {},
  existing,
  configPath: agent.configPath(),
  ...overrides,
});

describe('opencode integration', () => {
  it('speaks OpenAI and can reference a credential by variable', () => {
    expect(agent.surface).toBe('openai');
    expect(agent.supportsSecretReference).toBe(true);
    expect([...agent.roles]).toEqual(['default']);
  });

  it('writes a provider with the /v1 base URL and the model list', async () => {
    const { content } = await agent.render(plan(null));
    const written = JSON.parse(content) as {
      provider: Record<
        string,
        {
          name: string;
          npm: string;
          options: { baseURL: string };
          models: Record<string, { name: string }>;
        }
      >;
      model: string;
    };
    const provider = written.provider['llm-runtime-dock']!;
    expect(provider.name).toBe('LLM Runtime Dock');
    // OpenCode wants the /v1 suffix; Claude Code does not. Not normalized.
    expect(provider.options.baseURL).toBe('http://127.0.0.1:8787/v1');
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
    // Keys are the logical ids the client sends; `name` is the full model name.
    expect(Object.keys(provider.models).sort()).toEqual(['coding-fast', 'coding-quality']);
    expect(provider.models['coding-quality']!.name).toBe('Qwen3.8-27B');
    expect(provider.models['coding-fast']!.name).toBe('Qwen3.6-35B');
    expect(written.model).toBe('llm-runtime-dock/coding-quality');
  });

  it('states a limit only where the gateway knows it', async () => {
    const { content } = await agent.render(plan(null));
    const models = (
      JSON.parse(content) as {
        provider: Record<string, { models: Record<string, { limit?: unknown }> }>;
      }
    ).provider['llm-runtime-dock']!.models;

    expect(models['coding-quality']?.limit).toEqual({ context: 131072, output: 32768 });
    // A limit the gateway cannot state is omitted, never guessed.
    expect(models['coding-fast']?.limit).toBeUndefined();
  });

  it('writes an env-var reference rather than a resolved secret', async () => {
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
    expect(content).toContain('{env:MY_KEY}');
  });

  it('merges into an existing jsonc file, keeping comments and other providers', async () => {
    const existing = `{
  // my own note
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight",
  "provider": {
    "direct-backend": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8000/v1" }
    }
  }
}
`;
    const { content } = await agent.render(plan(existing));
    expect(content).toContain('// my own note');
    expect(content).toContain('tokyonight');
    // A provider pointing straight at a backend is a legitimate thing to have.
    expect(content).toContain('direct-backend');
    expect(content).toContain('llm-runtime-dock');
  });

  it('is idempotent', async () => {
    const first = await agent.render(plan(null));
    const second = await agent.render(plan(first.content));
    expect(second.content).toBe(first.content);
  });

  it('reports an unparseable config rather than overwriting it', async () => {
    await expect(agent.render(plan('{ "provider": '))).rejects.toMatchObject({
      code: 'AGENT_CONFIG_UNREADABLE',
    });
  });
});
