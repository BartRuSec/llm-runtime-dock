import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AcquireOptions,
  AcquireResult,
  AgentIntegration,
  ApplyPlan,
  Capabilities,
  ConfigLocation,
  Endpoint,
  HealthStatus,
  IdentityCheck,
  ModelInfo,
  ModelRelease,
  OptionSpec,
  ProbeQuestion,
  ProbeResult,
  ProbeStartResult,
  ProbeStartTarget,
  ProbeTarget,
  RenderedConfig,
  ReservedArg,
  RuntimeAdapter,
  RuntimeInstance,
  Surface,
} from '../../src/index.js';

/**
 * Stubs for core's own tests.
 *
 * Core must not depend on a concrete adapter (spec §6) — a rule pnpm enforces by
 * keeping `@llm-runtime-dock/*` out of `packages/core/node_modules`. Its tests
 * hold to the same rule, so what they exercise is core's contract rather than
 * some adapter's flags.
 */

export interface StubAdapterOptions {
  readonly id?: string;
  readonly modelRelease?: ModelRelease;
  readonly surfaces?: readonly Surface[];
  readonly optionSpecs?: Record<string, OptionSpec>;
  readonly reservedArgs?: readonly ReservedArg[];
  readonly serverScopedOptionKeys?: readonly string[];
  /** Ids `verifyIdentity` should report as served. Defaults to the entry's backend model. */
  readonly serves?: readonly string[];
  readonly probeResult?: ProbeResult;
  /** Declared probe questions. Defaults to none, which is a valid answer. */
  readonly probeQuestions?: readonly ProbeQuestion[];
  /** Where `startServer` reports the server came up. Absent means `--start` refuses. */
  readonly startsAt?: string;
  /** Make `acquire` reject, to exercise the scheduler's failure path. */
  readonly failAcquire?: Error;
  /** Make `release` reject, e.g. a pinned model that cannot be evicted. */
  readonly failRelease?: Error;
  readonly acquireDelayMs?: number;
  /** What `health` reports. `unreachable` is a runtime that is simply gone. */
  readonly healthState?: HealthStatus['state'];
  readonly ownership?: AcquireResult['ownership'];
}

export interface StubAdapter extends RuntimeAdapter {
  /** Lifecycle calls in order, e.g. `['acquire:a', 'release:a']`. */
  readonly calls: string[];
  /** What each `acquire` was told to leave loaded (§8), in call order. */
  readonly keepLoaded: (readonly string[])[];
}

export const createStubAdapter = (options: StubAdapterOptions = {}): StubAdapter => {
  const calls: string[] = [];
  const keepLoaded: (readonly string[])[] = [];
  const id = options.id ?? 'stub';

  const adapter: StubAdapter = {
    calls,
    keepLoaded,
    id,
    modelRelease: options.modelRelease ?? 'stop_server',
    defaultProbeTarget: 'http://127.0.0.1:9999',
    probeQuestions: options.probeQuestions ?? [],
    optionSpecs: options.optionSpecs ?? {},
    reservedArgs: options.reservedArgs ?? [],
    serverScopedOptionKeys: options.serverScopedOptionKeys ?? [],

    validateOptions: (raw) => {
      return raw ?? {};
    },

    probe: async (_target: ProbeTarget): Promise<ProbeResult> => {
      return options.probeResult ?? { status: 'not_running', url: 'http://127.0.0.1:9999' };
    },

    ...(options.startsAt !== undefined
      ? {
          startServer: async (target: ProbeStartTarget): Promise<ProbeStartResult> => {
            calls.push(`startServer:${target.host}:${target.port ?? ''}`);
            return { url: options.startsAt as string };
          },
        }
      : {}),

    acquire: async (
      runtime: RuntimeInstance,
      acquireOptions: AcquireOptions = {},
    ): Promise<AcquireResult> => {
      calls.push(`acquire:${runtime.id}`);
      keepLoaded.push(acquireOptions.keepLoaded ?? []);
      if (options.acquireDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.acquireDelayMs));
      }
      if (options.failAcquire) throw options.failAcquire;
      return { ownership: options.ownership ?? 'spawned' };
    },

    release: async (runtime: RuntimeInstance): Promise<void> => {
      calls.push(`release:${runtime.id}`);
      if (options.failRelease) throw options.failRelease;
    },

    start: async (runtime: RuntimeInstance): Promise<void> => {
      calls.push(`start:${runtime.id}`);
    },

    stop: async (runtime: RuntimeInstance): Promise<void> => {
      calls.push(`stop:${runtime.id}`);
    },

    health: async (): Promise<HealthStatus> => {
      return { state: options.healthState ?? 'ready' };
    },

    waitUntilReady: async (runtime: RuntimeInstance): Promise<void> => {
      calls.push(`ready:${runtime.id}`);
    },

    listModels: async (runtime: RuntimeInstance): Promise<ModelInfo[]> => {
      return (options.serves ?? [runtime.backendModel]).map((modelId) => ({
        id: modelId,
        loaded: true,
      }));
    },

    verifyIdentity: async (runtime: RuntimeInstance): Promise<IdentityCheck> => {
      const served = options.serves ?? [runtime.backendModel];
      return { ok: served.includes(runtime.backendModel), served };
    },

    servedModelId: (runtime: RuntimeInstance): string => {
      return runtime.backendModel;
    },

    capabilities: async (): Promise<Capabilities> => {
      return { surfaces: options.surfaces ?? ['openai', 'anthropic'], streaming: true };
    },

    endpoint: async (runtime: RuntimeInstance): Promise<Endpoint> => {
      return { baseUrl: `http://${runtime.host}:${runtime.port ?? 9999}/v1` };
    },
  };
  return adapter;
};

export interface StubAgentOptions {
  /**
   * Defaults to `opencode`: the `agents:` schema names the three real agents
   * (§12), so a role mapping only resolves for one of those ids.
   */
  readonly id?: string;
  readonly surface?: Surface;
  readonly supportsSecretReference?: boolean;
  readonly roles?: readonly string[];
  /** Defaults to true, which is the stricter path: apply refuses with no mapping. */
  readonly requiresRoleMapping?: boolean;
  readonly configPath: string;
  readonly installed?: boolean;
  /** Throw from `render`, to exercise the unreadable-config path. */
  readonly renderError?: Error;
}

export const createStubAgent = (options: StubAgentOptions): AgentIntegration => {
  return {
    id: options.id ?? 'opencode',
    displayName: 'Stub Agent',
    surface: options.surface ?? 'openai',
    supportsSecretReference: options.supportsSecretReference ?? true,
    roles: options.roles ?? ['default'],
    requiresRoleMapping: options.requiresRoleMapping ?? true,
    configPath: () => options.configPath,
    isInstalled: async () => options.installed ?? true,
    render: async (plan: ApplyPlan): Promise<RenderedConfig> => {
      if (options.renderError) throw options.renderError;
      // Deterministic, so an idempotency assertion is meaningful.
      return {
        path: options.configPath,
        content: `${JSON.stringify({ baseUrl: plan.gatewayBaseUrl, roles: plan.roles }, null, 2)}\n`,
        warnings: [],
      };
    },
  };
};

export const testLocation = (path = join(tmpdir(), 'lrd-stub-config.yaml')): ConfigLocation => {
  return { path, found: true, candidates: [path], source: 'flag' };
};

/** A temp directory removed at the end of the test. */
export const tempDir = (): { path: string; cleanup: () => void } => {
  const path = mkdtempSync(join(tmpdir(), 'lrd-core-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
};
