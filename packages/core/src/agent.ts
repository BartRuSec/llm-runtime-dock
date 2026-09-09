import type { DockConfig } from './config/load.js';
import { cliError } from './errors.js';
import type { AdapterRegistry } from './registry.js';
import type { Surface } from './types.js';

/**
 * Coding-agent integrations (spec §23).
 *
 * Each agent is its own package. Core knows nothing about provider blocks or
 * TOML tables, exactly as it knows nothing about CLI flags. `render` is pure so
 * that `--dry-run` and the real write share one code path.
 */

export interface AgentModelPlan {
  /** Logical model id, as the client sends it. */
  readonly id: string;
  /** The name written into this agent's config: the entry's `name`, or its `backend_model` when unset. */
  readonly name: string;
  readonly contextLimit: number | undefined;
  readonly outputLimit: number | undefined;
  /**
   * The env var holding this entry's upstream credential, if it has one.
   * Never the value; apply writes a reference or refuses (§23).
   */
  readonly apiKeyEnv: string | undefined;
}

export interface ApplyPlan {
  /** e.g. `http://127.0.0.1:8787`. Agents append their own path convention. */
  readonly gatewayBaseUrl: string;
  readonly models: readonly AgentModelPlan[];
  /** Role → logical model id, already merged with any CLI overrides. */
  readonly roles: Readonly<Record<string, string>>;
  /** Extra agent-specific settings from `agents:`, e.g. codex `reasoning_effort`. */
  readonly settings: Readonly<Record<string, string>>;
  /** Current file contents, or null when the file does not exist. */
  readonly existing: string | null;
  readonly configPath: string;
}

export interface RenderedConfig {
  readonly path: string;
  readonly content: string;
  /** e.g. "comments could not be preserved". Printed before writing (§23). */
  readonly warnings: readonly string[];
}

export interface AgentIntegration {
  readonly id: string;
  readonly displayName: string;
  /** The API protocol this agent speaks to the gateway (§23). */
  readonly surface: Surface;
  /**
   * Can this agent's config format reference a credential by environment
   * variable? Where it cannot, apply refuses rather than inlining a secret.
   */
  readonly supportsSecretReference: boolean;
  /** Role names this agent understands, in the order they should be reported. */
  readonly roles: readonly string[];
  /**
   * Is a role mapping the only thing that makes this apply useful?
   *
   * OpenCode says no: its provider block registers every configured model on
   * its own, and the default model is a separate setting the user may well have
   * chosen deliberately. Applying without a role mapping is still worth doing,
   * and leaves that choice alone.
   *
   * Claude Code and Codex say yes. Claude has no provider concept at all —
   * roles *are* the model selection — and Codex needs `model` alongside
   * `model_provider`. Writing either without a model produces a file that
   * points at nothing, so the caller has to supply one (§23).
   */
  readonly requiresRoleMapping: boolean;

  configPath(): string;
  isInstalled(): Promise<boolean>;
  /** Pure: produces the file content, writes nothing. */
  render(plan: ApplyPlan): Promise<RenderedConfig>;
}

export interface AgentRegistry {
  register(agent: AgentIntegration): AgentRegistry;
  get(id: string): AgentIntegration;
  has(id: string): boolean;
  list(): AgentIntegration[];
  ids(): string[];
}

export const createAgentRegistry = (agents: readonly AgentIntegration[] = []): AgentRegistry => {
  const byId = new Map<string, AgentIntegration>();
  const ids = (): string[] => [...byId.keys()];

  const registry: AgentRegistry = {
    register: (agent) => {
      byId.set(agent.id, agent);
      return registry;
    },

    get: (id) => {
      const agent = byId.get(id);
      if (!agent) {
        throw cliError('CONFIG_INVALID', `unknown coding agent "${id}"`, {
          hint: `known agents: ${ids().join(', ') || '(none)'}`,
        });
      }
      return agent;
    },

    has: (id) => byId.has(id),
    list: () => [...byId.values()],
    ids,
  };

  for (const agent of agents) registry.register(agent);
  return registry;
};

/** Roles configured for one agent in `agents:`, before CLI overrides. */
export const configuredRoles = (config: DockConfig, agentId: string): Record<string, string> => {
  const agents = config.agents;
  if (!agents) return {};
  if (agentId === 'claude') {
    const claude = agents.claude;
    if (!claude) return {};
    const roles: Record<string, string> = {};
    if (claude.opus) roles.opus = claude.opus;
    if (claude.sonnet) roles.sonnet = claude.sonnet;
    if (claude.haiku) roles.haiku = claude.haiku;
    return roles;
  }
  if (agentId === 'codex') return agents.codex ? { model: agents.codex.model } : {};
  if (agentId === 'opencode') return agents.opencode ? { default: agents.opencode.default } : {};
  return {};
};

export const configuredSettings = (config: DockConfig, agentId: string): Record<string, string> => {
  if (agentId === 'codex' && config.agents?.codex?.reasoning_effort) {
    return { reasoning_effort: config.agents.codex.reasoning_effort };
  }
  return {};
};

export interface BuildApplyPlanOptions {
  readonly config: DockConfig;
  readonly registry: AdapterRegistry;
  readonly agent: AgentIntegration;
  /** Role overrides for one run, e.g. `--opus coding-fast`. */
  readonly overrides?: Readonly<Record<string, string>>;
  readonly existing: string | null;
}

/**
 * Validate an agent's role mapping and turn it into a plan.
 *
 * Every failure here happens before anything is written: an unknown id, a role
 * whose runtime lacks the required surface, or a credential the format cannot
 * express (§23).
 */
export const buildApplyPlan = async (options: BuildApplyPlanOptions): Promise<ApplyPlan> => {
  const { config, registry, agent } = options;
  const roles = { ...configuredRoles(config, agent.id), ...(options.overrides ?? {}) };

  // An agent whose provider block stands on its own applies fine with no roles:
  // it registers the models and leaves the user's own default selection alone.
  if (agent.requiresRoleMapping && Object.keys(roles).length === 0) {
    throw cliError('CONFIG_INVALID', `no roles configured for ${agent.displayName}`, {
      details: { agent: agent.id },
      hint: `add an agents.${agent.id} block to ${config.location.path}, or pass a role override`,
    });
  }

  for (const [role, modelId] of Object.entries(roles)) {
    if (!agent.roles.includes(role)) {
      throw cliError('CONFIG_INVALID', `${agent.displayName} has no role "${role}"`, {
        details: { agent: agent.id, role },
        hint: `known roles: ${agent.roles.join(', ')}`,
      });
    }
    const instance = config.models.get(modelId);
    if (!instance) {
      throw cliError(
        'CONFIG_INVALID',
        `agents.${agent.id}.${role} names unknown model id "${modelId}"`,
        {
          details: { agent: agent.id, role, model: modelId, known: [...config.models.keys()] },
        },
      );
    }
    // A disabled entry is not part of the catalogue (§12), so writing it into
    // an agent's configuration would point that agent at something the gateway
    // answers 404 for. Refused here rather than at config load: `disabled` must
    // not stop every other command from reading the file.
    if (instance.disabled) {
      throw cliError(
        'CONFIG_INVALID',
        `agents.${agent.id}.${role} names "${modelId}", which is disabled in configuration`,
        {
          details: { agent: agent.id, role, model: modelId },
          hint: `map ${role} to an entry that is served, or remove "disabled: true" from models.${modelId}`,
        },
      );
    }
    const adapter = registry.get(instance.adapterId);
    const capabilities = await adapter.capabilities(instance);
    if (!capabilities.surfaces.includes(agent.surface)) {
      throw cliError(
        'AGENT_SURFACE_UNSUPPORTED',
        `${agent.displayName} speaks the ${agent.surface} API, but "${modelId}" (${adapter.id}) serves ${capabilities.surfaces.join(', ')}`,
        {
          details: {
            agent: agent.id,
            role,
            model: modelId,
            adapter: adapter.id,
            surface: agent.surface,
          },
          hint:
            adapter.id === 'custom'
              ? `add "surfaces: [openai, anthropic]" to runtimes.${instance.runtimeId} if that runtime really serves it`
              : `map ${role} to an entry whose runtime serves the ${agent.surface} surface`,
        },
      );
    }
    if (instance.auth && !agent.supportsSecretReference) {
      throw cliError(
        'AGENT_SECRET_UNSUPPORTED',
        `"${modelId}" needs an upstream credential, and ${agent.displayName}'s configuration format cannot reference one by environment variable`,
        {
          details: { agent: agent.id, model: modelId },
          hint: `map ${role} to a model whose runtime has no auth block; the gateway never writes a secret value into an agent config`,
        },
      );
    }
    if (instance.auth && !instance.auth.apiKeyEnv) {
      throw cliError(
        'AGENT_SECRET_UNSUPPORTED',
        `"${modelId}" supplies its credential through api_key_file, which cannot be written as an environment-variable reference`,
        {
          details: { agent: agent.id, model: modelId },
          hint: 'use auth.api_key_env so apply can write a reference instead of a value',
        },
      );
    }
  }

  const models: AgentModelPlan[] = [];
  for (const [id, instance] of config.models) {
    // Omitted, not refused: an agent that registers every configured model —
    // opencode's provider block — must not offer one the gateway will not route
    // (§12, §23).
    if (instance.disabled) continue;
    const adapter = registry.get(instance.adapterId);
    const limits = adapter.declaredLimits?.(instance) ?? {};
    models.push({
      id,
      name: instance.displayName,
      contextLimit: limits.context,
      outputLimit: limits.output,
      apiKeyEnv: instance.auth?.apiKeyEnv,
    });
  }

  return {
    gatewayBaseUrl: `http://${config.server.host}:${config.server.port}`,
    models,
    roles,
    settings: configuredSettings(config, agent.id),
    existing: options.existing,
    configPath: agent.configPath(),
  };
};
