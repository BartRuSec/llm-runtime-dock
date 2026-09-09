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
