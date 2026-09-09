import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCustomAdapter } from '@llm-runtime-dock/adapter-custom';
import { createMtplxAdapter } from '@llm-runtime-dock/adapter-mtplx';
import { createClaudeIntegration } from '@llm-runtime-dock/agent-claude';
import { createCodexIntegration } from '@llm-runtime-dock/agent-codex';
import { createOpenCodeIntegration } from '@llm-runtime-dock/agent-opencode';
import { applyAgent, createAdapterRegistry, parseConfig } from '@llm-runtime-dock/core';
import { runCli } from '@llm-runtime-dock/cli';
import type { CliError, DockConfig } from '@llm-runtime-dock/core';
import { fakeLocation, tempDir } from '../helpers/env.js';

/**
 * `apply` across real adapters and real agents (spec §23).
 *
 * Each agent's file format is tested in its own package, and the orchestration
 * contract in core. What is left here is the combination: a real runtime's
 * declared surface and limits reaching a real agent's configuration file.
 */

const registry = createAdapterRegistry([createMtplxAdapter(), createCustomAdapter()]);

const config = (
  extra = '',
  agents = 'agents:\n  opencode: { default: coding-quality }\n',
  extraRuntimes = '',
): DockConfig => {
  return parseConfig(
    registry,
    `
server: { host: 127.0.0.1, port: 8787 }
runtimes:
  mtplx: { adapter: mtplx, port: 8000 }
${extraRuntimes}models:
  coding-quality:
    runtime: mtplx
    backend_model: Qwen3.8-27B
    options: { context_window: 131072, max_tokens: 32768 }
  coding-fast:
    runtime: mtplx
    backend_model: Qwen3.6-35B
${extra}${agents}`,
    fakeLocation(),
  );
};

/** The prompting path goes through the real CLI, so it needs a config on disk. */
const writeConfigFile = (dir: string, agents: string): string => {
  const path = join(dir, 'lrd.yaml');
  writeFileSync(
    path,
    `server: { host: 127.0.0.1, port: 8787 }
runtimes:
  mtplx: { adapter: mtplx, port: 8000 }
models:
  coding-quality:
    runtime: mtplx
    backend_model: Qwen3.8-27B
  coding-fast:
    runtime: mtplx
    backend_model: Qwen3.6-35B
${agents}`,
  );
  return path;
};

describe('apply end to end', () => {
  let dir: ReturnType<typeof tempDir>;

  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it('carries a runtime’s launch limits into OpenCode’s model list', async () => {
    const configDir = join(dir.path, 'opencode');
    mkdirSync(configDir, { recursive: true });

    const result = await applyAgent({
      config: config(),
      registry,
      agent: createOpenCodeIntegration({ configDir }),
      skipInstalledCheck: true,
    });

    const written = JSON.parse(readFileSync(result.path, 'utf8')) as {
      provider: Record<
        string,
        { name: string; models: Record<string, { name?: string; limit?: unknown }> }
      >;
    };
    const provider = written.provider['llm-runtime-dock']!;
    const models = provider.models;
    // The full model name is the entry's `backend_model`, not the logical id.
    expect(provider.name).toBe('LLM Runtime Dock');
    expect(models['coding-quality']?.name).toBe('Qwen3.8-27B');
    // context_window/max_tokens are MTPLX start-time flags; the adapter states
    // them, and only where it can.
    expect(models['coding-quality']?.limit).toEqual({ context: 131072, output: 32768 });
    expect(models['coding-fast']?.limit).toBeUndefined();
  });

  it('writes the entry `name` into OpenCode when set, ignoring backend_model', async () => {
    const configDir = join(dir.path, 'opencode');
    mkdirSync(configDir, { recursive: true });

    const config = parseConfig(
      registry,
      `server: { host: 127.0.0.1, port: 8787 }
runtimes:
  mtplx: { adapter: mtplx, port: 8000 }
models:
  coding-quality:
    runtime: mtplx
    backend_model: Qwen3.8-27B
    name: Qwen 3.8
agents:
  opencode: { default: coding-quality }
`,
      fakeLocation(),
    );

    const result = await applyAgent({
      config,
      registry,
      agent: createOpenCodeIntegration({ configDir }),
      skipInstalledCheck: true,
    });

    const written = JSON.parse(readFileSync(result.path, 'utf8')) as {
      provider: Record<string, { models: Record<string, { name?: string }> }>;
    };
    const models = written.provider['llm-runtime-dock']!.models;
    expect(models['coding-quality']?.name).toBe('Qwen 3.8');
  });

  it('maps Claude Code roles from the agents block and backs the file up', async () => {
    const configDir = join(dir.path, 'claude');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, 'settings.json');
    writeFileSync(path, JSON.stringify({ env: { MY_OWN_VAR: 'keep-me' } }, null, 2));

    const result = await applyAgent({
      config: config(
        '',
        'agents:\n  claude: { opus: coding-quality, sonnet: coding-quality, haiku: coding-fast }\n',
      ),
      registry,
      agent: createClaudeIntegration({ configDir }),
      skipInstalledCheck: true,
    });

    expect(result.backup).toBeTruthy();
    const written = JSON.parse(readFileSync(path, 'utf8')) as { env: Record<string, string> };
    expect(written.env.MY_OWN_VAR).toBe('keep-me');
    expect(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('coding-quality');
    expect(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('coding-fast');
  });

  it('refuses a Claude role whose runtime serves only OpenAI, before writing', async () => {
    const configDir = join(dir.path, 'claude');
    mkdirSync(configDir, { recursive: true });

    // A custom entry declares OpenAI only unless it opts in (§11).
    const withCustom = config(
      '  openai-only: { runtime: legacy, backend_model: m }\n',
      'agents:\n  claude: { opus: openai-only }\n',
      `  legacy:
    adapter: custom
    process:
      start: { command: ["some-runtime", "serve"] }
    health: { url: "http://127.0.0.1:9100/health" }
    model_discovery: { url: "http://127.0.0.1:9100/v1/models" }
    endpoint: { url: "http://127.0.0.1:9100/v1" }
`,
    );

    let thrown: unknown;
    try {
      await applyAgent({
        config: withCustom,
        registry,
        agent: createClaudeIntegration({ configDir }),
        skipInstalledCheck: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as CliError).code).toBe('AGENT_SURFACE_UNSUPPORTED');
    // The discovery worth designing away is finding this when Claude Code is
    // already pointed at a dead configuration.
    expect(readdirSync(configDir)).toHaveLength(0);
  });

  it('applies to every agent named in agents:, skipping one that is not installed', async () => {
    const claudeDir = join(dir.path, 'claude');
    const opencodeDir = join(dir.path, 'opencode');
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(opencodeDir, { recursive: true });
    // Codex's directory is deliberately absent.
    const codexDir = join(dir.path, 'codex-missing');

    const full = config(
      '',
      'agents:\n  claude: { opus: coding-quality }\n  codex: { model: coding-quality }\n  opencode: { default: coding-quality }\n',
    );

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const agent of [
      createClaudeIntegration({ configDir: claudeDir }),
      createCodexIntegration({ configDir: codexDir }),
      createOpenCodeIntegration({ configDir: opencodeDir }),
    ]) {
      try {
        applied.push((await applyAgent({ config: full, registry, agent })).agent);
      } catch (error) {
        expect((error as CliError).code).toBe('AGENT_NOT_INSTALLED');
        skipped.push(agent.id);
      }
    }

    // One missing agent must not stop the others.
    expect(applied).toEqual(['claude', 'opencode']);
    expect(skipped).toEqual(['codex']);
    expect(readdirSync(claudeDir)).toContain('settings.json');
    expect(readdirSync(opencodeDir)).toContain('opencode.json');
  });

  it('registers OpenCode’s provider without touching a default it did not set', async () => {
    const configDir = join(dir.path, 'opencode');
    mkdirSync(configDir, { recursive: true });
    const path = join(configDir, 'opencode.json');
    // The user already chose a model, from a provider that is none of ours.
    writeFileSync(
      path,
      JSON.stringify({ model: 'anthropic/claude-opus-4', theme: 'dark' }, null, 2),
    );

    const result = await applyAgent({
      // No agents: block at all.
      config: config('', ''),
      registry,
      agent: createOpenCodeIntegration({ configDir }),
      skipInstalledCheck: true,
    });

    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      model: string;
      theme: string;
      provider: Record<string, { models: Record<string, unknown> }>;
    };
    // The provider block is useful on its own: every configured model is there.
    expect(Object.keys(written.provider['llm-runtime-dock']!.models).sort()).toEqual([
      'coding-fast',
      'coding-quality',
    ]);
    // ...and the selection the user made is left exactly as it was.
    expect(written.model).toBe('anthropic/claude-opus-4');
    expect(written.theme).toBe('dark');
    expect(result.roles).toEqual({});
  });

  it('asks which model each Claude role should use when the config says nothing', async () => {
    const configDir = join(dir.path, 'claude');
    mkdirSync(configDir, { recursive: true });
    const asked: string[] = [];
    const out: string[] = [];

    const code = await runCli({
      argv: ['apply', 'claude', '--config', writeConfigFile(dir.path, '')],
      adapters: [createMtplxAdapter(), createCustomAdapter()],
      agents: [createClaudeIntegration({ configDir })],
      stdout: (l) => out.push(l),
      stderr: () => {},
      // Standing in for the inquirer prompt: pick the first model every time.
      rolePrompt: async ({ role, choices }) => {
        asked.push(role);
        return choices[0]!;
      },
    });

    expect(code).toBe(0);
    // One question per role, from the configured model ids.
    expect(asked).toEqual(['opus', 'sonnet', 'haiku']);
    const written = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as {
      env: Record<string, string>;
    };
    expect(written.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('coding-quality');
    expect(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('coding-quality');
  });

  it('asks Codex for a model, and honours a role left unset', async () => {
    const configDir = join(dir.path, 'codex');
    mkdirSync(configDir, { recursive: true });

    const chosen = await runCli({
      argv: ['apply', 'codex', '--config', writeConfigFile(dir.path, '')],
      adapters: [createMtplxAdapter(), createCustomAdapter()],
      agents: [createCodexIntegration({ configDir })],
      stdout: () => {},
      stderr: () => {},
      rolePrompt: async ({ choices }) => choices[1]!,
    });
    expect(chosen).toBe(0);
    expect(readFileSync(join(configDir, 'config.toml'), 'utf8')).toContain('model = "coding-fast"');

    // Skipping every role writes nothing rather than a file pointing at nothing.
    const empty = join(dir.path, 'codex-empty');
    mkdirSync(empty, { recursive: true });
    const errs: string[] = [];
    const code = await runCli({
      argv: ['apply', 'codex', '--config', writeConfigFile(dir.path, '')],
      adapters: [createMtplxAdapter(), createCustomAdapter()],
      agents: [createCodexIntegration({ configDir: empty })],
      stdout: () => {},
      stderr: (l) => errs.push(l),
      rolePrompt: async () => null,
    });
    expect(code).not.toBe(0);
    expect(errs.join('\n')).toContain('no roles chosen');
    expect(readdirSync(empty)).toHaveLength(0);
  });

  it('fails readably instead of hanging when it cannot ask', async () => {
    const configDir = join(dir.path, 'claude');
    mkdirSync(configDir, { recursive: true });
    const errs: string[] = [];

    // No rolePrompt: a pipeline, a CI job, or --json. Never a blocked prompt.
    const code = await runCli({
      argv: ['apply', 'claude', '--json', '--config', writeConfigFile(dir.path, '')],
      adapters: [createMtplxAdapter(), createCustomAdapter()],
      agents: [createClaudeIntegration({ configDir })],
      stdout: () => {},
      stderr: (l) => errs.push(l),
    });

    expect(code).not.toBe(0);
    expect(errs.join('\n')).toContain('no roles configured');
    expect(readdirSync(configDir)).toHaveLength(0);
  });

  it('is idempotent across every agent', async () => {
    const configDir = join(dir.path, 'codex');
    mkdirSync(configDir, { recursive: true });
    const agent = createCodexIntegration({ configDir });
    const full = config(
      '',
      'agents:\n  codex: { model: coding-quality, reasoning_effort: high }\n',
    );

    const first = await applyAgent({ config: full, registry, agent, skipInstalledCheck: true });
    const contents = readFileSync(first.path, 'utf8');
    const second = await applyAgent({ config: full, registry, agent, skipInstalledCheck: true });

    expect(second.unchanged).toBe(true);
    expect(readFileSync(first.path, 'utf8')).toBe(contents);
  });
});
