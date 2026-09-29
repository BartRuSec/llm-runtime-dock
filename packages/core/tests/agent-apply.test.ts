import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyAgent,
  buildApplyPlan,
  cliError,
  createAdapterRegistry,
  parseConfig,
} from '../src/index.js';
import type { DockConfig } from '../src/index.js';
import { createStubAdapter, createStubAgent, testLocation } from './helpers/stubs.js';

/**
 * `applyAgent` orchestration (spec §23). What each agent's file format looks
 * like is that agent package's business; what core owns is the checks that run
 * before anything is written, and the merge/backup/idempotency contract.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-apply-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const configWith = (extra = '', agents = 'agents:\n  opencode: { default: a }\n'): DockConfig => {
  const registry = createAdapterRegistry([
    createStubAdapter(),
    createStubAdapter({ id: 'openai-only', surfaces: ['openai'] }),
  ]);
  return parseConfig(
    registry,
    `
server: { host: 127.0.0.1, port: 8787 }
runtimes:
  stub: { adapter: stub, port: 8000 }
  stub2: { adapter: stub, port: 8001 }
  openai-only: { adapter: openai-only, port: 8002 }
  keyed: { adapter: stub, port: 8003, auth: { api_key_env: MY_KEY } }
  filed: { adapter: stub, port: 8004, auth: { api_key_file: ~/key } }
models:
  a: { runtime: stub, backend_model: Model-A }
${extra}${agents}`,
    testLocation(),
  );
};

const registry = () =>
  createAdapterRegistry([
    createStubAdapter(),
    createStubAdapter({ id: 'openai-only', surfaces: ['openai'] }),
  ]);

describe('applyAgent', () => {
  it('writes the rendered file and reports the path', async () => {
    const path = join(dir, 'agent.json');
    const result = await applyAgent({
      config: configWith(),
      registry: registry(),
      agent: createStubAgent({ configPath: path }),
    });
    expect(result.written).toBe(true);
    expect(result.path).toBe(path);
    expect(readFileSync(path, 'utf8')).toContain('http://127.0.0.1:8787');
  });

  it('is idempotent, and makes no second backup', async () => {
    const path = join(dir, 'agent.json');
    const agent = createStubAgent({ configPath: path });

    await applyAgent({ config: configWith(), registry: registry(), agent });
    const first = readFileSync(path, 'utf8');

    const second = await applyAgent({ config: configWith(), registry: registry(), agent });
    expect(second.unchanged).toBe(true);
    expect(second.written).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toHaveLength(0);
  });

  it('backs the previous version up before overwriting', async () => {
    const path = join(dir, 'agent.json');
    writeFileSync(path, '{"mine":true}');
    const result = await applyAgent({
      config: configWith(),
      registry: registry(),
      agent: createStubAgent({ configPath: path }),
    });
    expect(result.backup).toBeTruthy();
    expect(readFileSync(result.backup as string, 'utf8')).toBe('{"mine":true}');
  });

  it('applies a role override for one run', async () => {
    const config = configWith(
      '  b: { runtime: stub2, backend_model: Model-B }\n',
      'agents:\n  opencode: { default: a }\n',
    );
    const result = await applyAgent({
      config,
      registry: registry(),
      agent: createStubAgent({ configPath: join(dir, 'agent.json') }),
      overrides: { default: 'b' },
    });
    expect(result.roles).toEqual({ default: 'b' });
  });

  it('refuses a role whose runtime lacks the required surface, before writing', async () => {
    const config = configWith(
      '  openai-model: { runtime: openai-only, backend_model: M }\n',
      'agents:\n  opencode: { default: openai-model }\n',
    );
    const path = join(dir, 'agent.json');
    await expect(
      applyAgent({
        config,
        registry: registry(),
        agent: createStubAgent({ configPath: path, surface: 'anthropic' }),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_SURFACE_UNSUPPORTED' });
    expect(existsSync(path)).toBe(false);
  });

  it('leaves a disabled entry out of the model list it hands the agent', async () => {
    // opencode's provider block registers every model in the plan, so an entry
    // the gateway answers 404 for must never reach it (§12, §23).
    const config = configWith(
      '  hidden: { runtime: stub2, backend_model: Embed-M, disabled: true }\n',
    );
    const plan = await buildApplyPlan({
      config,
      registry: registry(),
      agent: createStubAgent({ configPath: join(dir, 'agent.json') }),
      existing: null,
    });
    expect(plan.models.map((model) => model.id)).toEqual(['a']);
  });

  it('refuses a role that names a disabled entry, before writing', async () => {
    const config = configWith(
      '  hidden: { runtime: stub2, backend_model: Embed-M, disabled: true }\n',
      'agents:\n  opencode: { default: hidden }\n',
    );
    const path = join(dir, 'agent.json');
    await expect(
      applyAgent({ config, registry: registry(), agent: createStubAgent({ configPath: path }) }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses rather than inlining a secret the format cannot reference', async () => {
    const config = configWith(
      '  secret: { runtime: keyed, backend_model: M }\n',
      'agents:\n  opencode: { default: secret }\n',
    );
    const path = join(dir, 'agent.json');
    await expect(
      applyAgent({
        config,
        registry: registry(),
        agent: createStubAgent({ configPath: path, supportsSecretReference: false }),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_SECRET_UNSUPPORTED' });
    expect(existsSync(path)).toBe(false);
  });

  it('refuses an api_key_file, which has no variable name to reference', async () => {
    const config = configWith(
      '  secret: { runtime: filed, backend_model: M }\n',
      'agents:\n  opencode: { default: secret }\n',
    );
    await expect(
      applyAgent({
        config,
        registry: registry(),
        agent: createStubAgent({ configPath: join(dir, 'agent.json') }),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_SECRET_UNSUPPORTED' });
  });

  it('reports an agent that is not installed, without writing', async () => {
    const path = join(dir, 'agent.json');
    await expect(
      applyAgent({
        config: configWith(),
        registry: registry(),
        agent: createStubAgent({ configPath: path, installed: false }),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_INSTALLED' });
    expect(existsSync(path)).toBe(false);
  });

  it('propagates an unreadable agent config and leaves the file alone', async () => {
    const path = join(dir, 'agent.json');
    writeFileSync(path, 'not parseable');
    await expect(
      applyAgent({
        config: configWith(),
        registry: registry(),
        agent: createStubAgent({
          configPath: path,
          renderError: cliError('AGENT_CONFIG_UNREADABLE', 'cannot parse'),
        }),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_CONFIG_UNREADABLE' });
    expect(readFileSync(path, 'utf8')).toBe('not parseable');
  });

  it('rejects a role the agent does not have', async () => {
    await expect(
      applyAgent({
        config: configWith(),
        registry: registry(),
        agent: createStubAgent({ configPath: join(dir, 'agent.json'), roles: ['other'] }),
      }),
    ).rejects.toMatchObject({ namespace: 'cli' });
  });

  it('dry-run renders without writing', async () => {
    mkdirSync(join(dir, 'sub'));
    const path = join(dir, 'sub', 'agent.json');
    const result = await applyAgent({
      config: configWith(),
      registry: registry(),
      agent: createStubAgent({ configPath: path }),
      dryRun: true,
    });
    expect(result.written).toBe(false);
    expect(result.content).toContain('8787');
    expect(existsSync(path)).toBe(false);
  });
});

/**
 * The gateway's own inbound key (§28) threads through `ApplyPlan` alongside
 * `gatewayBaseUrl` — a different hop than `AgentModelPlan.apiKeyEnv`, which
 * `applyAgent` above already covers. `env` is always passed explicitly so
 * these never depend on the real process environment.
 */
describe('gateway API-key wiring', () => {
  const withServerAuth = (auth: string, env: NodeJS.ProcessEnv) =>
    parseConfig(
      registry(),
      `
server: { host: 127.0.0.1, port: 8787${auth} }
runtimes:
  stub: { adapter: stub, port: 8000 }
models:
  a: { runtime: stub, backend_model: Model-A }
agents:
  opencode: { default: a }
`,
      testLocation(),
      env,
    );

  it('exposes the env var name without resolving a literal, for a reference-capable agent', async () => {
    // The name is a config fact, not a secret, so a reference-capable format
    // (OpenCode, Codex) must apply correctly even when this process cannot
    // see the value itself — e.g. a Docker deployment injects it into the
    // gateway's own container only. `env` deliberately omits the variable.
    const config = withServerAuth(', auth: { api_key_env: MY_GATEWAY_KEY }', {});
    const plan = await buildApplyPlan({
      config,
      registry: registry(),
      agent: createStubAgent({
        configPath: join(dir, 'agent.json'),
        supportsSecretReference: true,
      }),
      existing: null,
      env: {},
    });
    expect(plan.gatewayApiKeyEnv).toBe('MY_GATEWAY_KEY');
    expect(plan.gatewayApiKey).toBeUndefined();
  });

  it('resolves the literal for an agent with no reference syntax at all', async () => {
    const env = { MY_GATEWAY_KEY: 'super-secret' };
    const config = withServerAuth(', auth: { api_key_env: MY_GATEWAY_KEY }', env);
    const plan = await buildApplyPlan({
      config,
      registry: registry(),
      agent: createStubAgent({
        configPath: join(dir, 'agent.json'),
        supportsSecretReference: false,
      }),
      existing: null,
      env,
    });
    expect(plan.gatewayApiKeyEnv).toBe('MY_GATEWAY_KEY');
    expect(plan.gatewayApiKey).toBe('super-secret');
  });

  it('resolves the literal for a reference-capable agent when the key has no variable name', async () => {
    const keyFile = join(dir, 'api_key');
    writeFileSync(keyFile, 'file-secret\n');
    const config = withServerAuth(`, auth: { api_key_file: ${keyFile} }`, {});
    const plan = await buildApplyPlan({
      config,
      registry: registry(),
      agent: createStubAgent({
        configPath: join(dir, 'agent.json'),
        supportsSecretReference: true,
      }),
      existing: null,
      env: {},
    });
    expect(plan.gatewayApiKeyEnv).toBeUndefined();
    expect(plan.gatewayApiKey).toBe('file-secret');
  });

  it('leaves both undefined when no gateway key is configured', async () => {
    const config = withServerAuth('', {});
    const plan = await buildApplyPlan({
      config,
      registry: registry(),
      agent: createStubAgent({ configPath: join(dir, 'agent.json') }),
      existing: null,
    });
    expect(plan.gatewayApiKeyEnv).toBeUndefined();
    expect(plan.gatewayApiKey).toBeUndefined();
  });

  it('exposes the OOTB LRD_API_KEY name the same way, with no server.auth block at all', async () => {
    const config = withServerAuth('', { LRD_API_KEY: 'ootb-secret' });
    const plan = await buildApplyPlan({
      config,
      registry: registry(),
      agent: createStubAgent({
        configPath: join(dir, 'agent.json'),
        supportsSecretReference: true,
      }),
      existing: null,
      env: {},
    });
    expect(plan.gatewayApiKeyEnv).toBe('LRD_API_KEY');
    expect(plan.gatewayApiKey).toBeUndefined();
  });

  it('fails closed rather than silently applying, for an agent that needs the literal', async () => {
    const config = withServerAuth(', auth: { api_key_env: UNSET_VAR } ', {});
    await expect(
      applyAgent({
        config,
        registry: registry(),
        agent: createStubAgent({
          configPath: join(dir, 'agent.json'),
          supportsSecretReference: false,
        }),
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'SERVER_AUTH_UNRESOLVED' });
  });

  it('does not fail closed for a reference-capable agent when the literal cannot resolve', async () => {
    // OpenCode/Codex only need the variable *name* here — the value living
    // solely in the gateway's own container (e.g. Docker) must not block them.
    const config = withServerAuth(', auth: { api_key_env: UNSET_VAR } ', {});
    const plan = await buildApplyPlan({
      config,
      registry: registry(),
      agent: createStubAgent({
        configPath: join(dir, 'agent.json'),
        supportsSecretReference: true,
      }),
      existing: null,
      env: {},
    });
    expect(plan.gatewayApiKeyEnv).toBe('UNSET_VAR');
    expect(plan.gatewayApiKey).toBeUndefined();
  });
});
