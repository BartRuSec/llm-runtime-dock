import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplyPlan } from '@llm-runtime-dock/core';
import { createClaudeIntegration } from '../src/index.js';

/** Claude Code's own configuration shape (spec §23). `render` is pure. */

const agent = createClaudeIntegration({ configDir: join(tmpdir(), 'claude-test') });

const plan = (existing: string | null, roles: Record<string, string> = {}): ApplyPlan => ({
  gatewayBaseUrl: 'http://127.0.0.1:8787',
  models: [
    {
      id: 'coding-quality',
      name: 'Qwen3.8-27B',
      contextLimit: 131072,
      outputLimit: 32768,
      apiKeyEnv: undefined,
    },
  ],
  roles: { opus: 'coding-quality', sonnet: 'coding-quality', haiku: 'coding-fast', ...roles },
  settings: {},
  existing,
  configPath: agent.configPath(),
});

describe('claude code integration', () => {
  it('speaks Anthropic and cannot reference a secret', () => {
    expect(agent.surface).toBe('anthropic');
    // settings.json env values are literal strings Claude Code exports verbatim.
    expect(agent.supportsSecretReference).toBe(false);
    expect([...agent.roles]).toEqual(['opus', 'sonnet', 'haiku']);
    expect(agent.configPath()).toMatch(/settings\.json$/);
  });

  it('maps roles onto the env block, with no /v1 suffix on the base URL', async () => {
    const { content } = await agent.render(plan(null));
    const written = JSON.parse(content) as { env: Record<string, string> };
    // Claude Code appends /v1/messages itself; that convention is load-bearing.
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
    expect(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('coding-quality');
    expect(written.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('coding-quality');
    expect(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('coding-fast');
    // The gateway is unauthenticated on loopback, so no key is needed.
    expect(written.env.ANTHROPIC_API_KEY).toBe('');
  });

  it('merges, preserving every key it does not own', async () => {
    const existing = JSON.stringify({
      $schema: 'https://example.com/schema.json',
      permissions: { allow: ['Bash(ls:*)'] },
      env: { MY_OWN_VAR: 'keep-me', ANTHROPIC_BASE_URL: 'http://old:1234' },
      statusLine: { type: 'command', command: 'mine' },
    });
    const { content } = await agent.render(plan(existing));
    const written = JSON.parse(content) as Record<string, unknown> & {
      env: Record<string, string>;
    };

    expect(written.$schema).toBe('https://example.com/schema.json');
    expect(written.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(written.statusLine).toEqual({ type: 'command', command: 'mine' });
    expect(written.env.MY_OWN_VAR).toBe('keep-me');
    // Only the keys the gateway owns are replaced.
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
  });

  it('keeps an API key the user set themselves', async () => {
    const existing = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'user-set' } });
    const { content } = await agent.render(plan(existing));
    expect((JSON.parse(content) as { env: Record<string, string> }).env.ANTHROPIC_API_KEY).toBe(
      'user-set',
    );
  });

  it('is idempotent', async () => {
    const first = await agent.render(plan(null));
    const second = await agent.render(plan(first.content));
    expect(second.content).toBe(first.content);
  });

  it('reports an unparseable config rather than overwriting it', async () => {
    await expect(agent.render(plan('{ not json'))).rejects.toMatchObject({
      code: 'AGENT_CONFIG_UNREADABLE',
    });
    await expect(agent.render(plan('[]'))).rejects.toMatchObject({ namespace: 'cli' });
  });

  it('refuses a commented file rather than reformatting it away', async () => {
    // settings.json is strict JSON, so comments make it genuinely unreadable.
    // Refusing is more honest than rewriting the user's file without them.
    await expect(agent.render(plan('{\n  // mine\n  "env": {}\n}'))).rejects.toMatchObject({
      code: 'AGENT_CONFIG_UNREADABLE',
    });
  });
});
