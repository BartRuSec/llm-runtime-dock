import type { AgentIntegration, ApplyAgentResult, DockConfig } from '@llm-runtime-dock/core';
import {
  applyAgent,
  cliError,
  configuredRoles,
  isCliError,
  servedModelIds,
} from '@llm-runtime-dock/core';
import type { CliError } from '@llm-runtime-dock/core';
import type { CliContext } from '../context.js';

/**
 * `lrd apply` (spec §23, §27).
 *
 * Writes the gateway into a coding agent's own configuration, from the
 * configuration the gateway already has. Merges, backs up, never writes a
 * secret value, and is idempotent.
 */

export interface ApplyCommandOptions {
  readonly all?: boolean;
  readonly dryRun?: boolean;
  /** Per-agent role overrides for one run: `--opus`, `--sonnet`, `--haiku`, `--model`. */
  readonly opus?: string;
  readonly sonnet?: string;
  readonly haiku?: string;
  readonly model?: string;
}

export const runApply = async (
  context: CliContext,
  agentId: string | undefined,
  options: ApplyCommandOptions,
): Promise<number> => {
  const config = context.loadConfig();

  const targets = selectAgents(context, agentId, options, config.agents);
  const results: ApplyAgentResult[] = [];
  const failures: Array<{ agent: string; error: CliError }> = [];

  for (const agent of targets) {
    try {
      const result = await applyAgent({
        config,
        registry: context.adapters,
        agent,
        overrides: await resolveOverrides(context, config, agent, options),
        dryRun: options.dryRun === true,
      });
      results.push(result);
      reportOne(context, agent, result, options.dryRun === true);
    } catch (error) {
      // A single named agent fails the command outright. With --all, one agent
      // that is missing or misconfigured must not stop the others: report it,
      // carry on, and still exit non-zero at the end.
      if (targets.length === 1) throw error;
      if (!isCliError(error)) throw error;
      failures.push({ agent: agent.displayName, error });
      context.err(
        `${context.theme.warn(`skipped ${agent.displayName}`)}: [${error.code}] ${error.message}`,
      );
      if (error.hint) context.err(context.theme.muted(`  hint: ${error.hint}`));
    }
  }

  if (context.options.json) {
    context.json(
      results.map((result) => ({
        agent: result.agent,
        path: result.path,
        written: result.written,
        unchanged: result.unchanged,
        backup: result.backup,
        roles: result.roles,
        warnings: result.warnings,
      })),
    );
  }
  return failures.length > 0 ? 1 : 0;
};

const selectAgents = (
  context: CliContext,
  agentId: string | undefined,
  options: ApplyCommandOptions,
  agents: { claude?: unknown; codex?: unknown; opencode?: unknown } | undefined,
): AgentIntegration[] => {
  if (options.all === true) {
    if (!agents) {
      throw cliError('CONFIG_INVALID', '--all needs an agents: section in the configuration', {
        hint: 'add agents: with the roles each coding agent should use',
      });
    }
    const named = Object.keys(agents).filter(
      (key) => agents[key as keyof typeof agents] !== undefined,
    );
    return named.map((id) => context.agent(id));
  }
  if (!agentId) {
    throw cliError('CONFIG_INVALID', 'name an agent, or pass --all', {
      hint: `known agents: ${context.agents.ids().join(', ')}`,
    });
  }
  return [context.agent(agentId)];
};

const overridesFor = (
  agent: AgentIntegration,
  options: ApplyCommandOptions,
): Record<string, string> => {
  const overrides: Record<string, string> = {};
  if (agent.id === 'claude') {
    if (options.opus) overrides.opus = options.opus;
    if (options.sonnet) overrides.sonnet = options.sonnet;
    if (options.haiku) overrides.haiku = options.haiku;
  } else if (agent.id === 'codex') {
    if (options.model) overrides.model = options.model;
  } else if (agent.id === 'opencode') {
    if (options.model) overrides.default = options.model;
  }
  return overrides;
};

/**
 * The role mapping this run should use.
 *
 * Configuration first, CLI flags on top. If that leaves an agent that cannot do
 * anything useful without a mapping (§23) with nothing at all, ask — the choices are the model ids the configuration already
 * declares. An agent whose provider block stands on its own is left alone, so
 * `lrd apply opencode` with no `agents.opencode` registers the models and does
 * not touch whichever default the user picked in OpenCode itself.
 */
const resolveOverrides = async (
  context: CliContext,
  config: DockConfig,
  agent: AgentIntegration,
  options: ApplyCommandOptions,
): Promise<Record<string, string>> => {
  const overrides = overridesFor(agent, options);
  const configured = configuredRoles(config, agent.id);
  const resolved = { ...configured, ...overrides };
  if (!agent.requiresRoleMapping || Object.keys(resolved).length > 0) return overrides;

  // Only what the gateway serves: offering a disabled entry here would produce
  // a mapping `buildApplyPlan` then refuses (§12).
  const choices = servedModelIds(config);
  if (choices.length === 0) {
    const disabled = config.models.size > 0;
    throw cliError('CONFIG_INVALID', 'there are no models: entries to map a role to', {
      details: { agent: agent.id },
      hint: disabled
        ? 'every configured entry is disabled; remove "disabled: true" from the one this agent should use'
        : 'run `lrd probe <adapter> --save` to discover what this machine serves',
    });
  }
  if (!context.rolePrompt) {
    // No terminal, or --json. Fail the way this always failed rather than
    // hanging on a prompt nobody can answer.
    throw cliError('CONFIG_INVALID', `no roles configured for ${agent.displayName}`, {
      details: { agent: agent.id },
      hint: `add an agents.${agent.id} block to ${config.location.path}, or pass a role override`,
    });
  }

  context.err(`no agents.${agent.id} in ${config.location.path} — asking instead`);
  const answers: Record<string, string> = { ...overrides };
  for (const role of agent.roles) {
    if (answers[role] !== undefined) continue;
    const answer = await context.rolePrompt({
      agentDisplayName: agent.displayName,
      role,
      choices,
    });
    if (answer !== null) answers[role] = answer;
  }

  if (Object.keys(answers).length === 0) {
    throw cliError('CONFIG_INVALID', `no roles chosen for ${agent.displayName}`, {
      details: { agent: agent.id },
      hint: `nothing was written; re-run and pick a model, or add an agents.${agent.id} block`,
    });
  }
  context.err(`add this to ${config.location.path} to skip the questions next time:`);
  context.err(`  agents:\n    ${agent.id}:`);
  for (const [role, model] of Object.entries(answers)) context.err(`      ${role}: ${model}`);
  return answers;
};

const reportOne = (
  context: CliContext,
  agent: AgentIntegration,
  result: ApplyAgentResult,
  dryRun: boolean,
): void => {
  if (context.options.json) return;
  for (const warning of result.warnings) {
    context.err(`${context.theme.warn('warning:')} ${warning}`);
  }

  const roles = Object.entries(result.roles)
    .map(([role, model]) => `${role}=${model}`)
    .join(' ');
  // No mapping is a normal outcome for an agent whose provider block stands on
  // its own; say what was left alone rather than printing an empty list.
  context.out(
    `${agent.displayName} (${agent.surface}): ${roles || 'no role mapping — existing model selection left unchanged'}`,
  );

  if (dryRun) {
    context.out(context.theme.muted(`--- ${result.path} (dry run, nothing written) ---`));
    context.out(result.content.trimEnd());
    return;
  }
  if (result.unchanged) {
    context.out(`${context.theme.path(result.path)} ${context.theme.muted('already up to date')}`);
    return;
  }
  if (result.backup) context.out(context.theme.muted(`backup: ${result.backup}`));
  context.out(`${context.theme.ok('wrote')} ${context.theme.path(result.path)}`);
};
