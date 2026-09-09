import type { AgentIntegration } from './agent.js';
import { buildApplyPlan } from './agent.js';
import type { DockConfig } from './config/load.js';
import { cliError } from './errors.js';
import { backupFile, readTextIfExists, writeTextFile } from './fs-utils.js';
import type { AdapterRegistry } from './registry.js';

/**
 * Writing the gateway into a coding agent's own configuration (spec §23).
 *
 * Agent configuration files belong to the user. Every apply merges, preserves
 * every key it does not own, backs up first, and is idempotent. `--dry-run` and
 * the real write share this code path; only the last two lines differ.
 */

export interface ApplyAgentOptions {
  readonly config: DockConfig;
  readonly registry: AdapterRegistry;
  readonly agent: AgentIntegration;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly dryRun?: boolean;
  /** Skip the installed check. Only for tests against a temp directory. */
  readonly skipInstalledCheck?: boolean;
}

export interface ApplyAgentResult {
  readonly agent: string;
  readonly path: string;
  readonly content: string;
  readonly backup: string | null;
  readonly written: boolean;
  readonly unchanged: boolean;
  readonly warnings: readonly string[];
  readonly roles: Readonly<Record<string, string>>;
}

export const applyAgent = async (options: ApplyAgentOptions): Promise<ApplyAgentResult> => {
  const { agent } = options;

  if (!options.skipInstalledCheck && !(await agent.isInstalled())) {
    throw cliError('AGENT_NOT_INSTALLED', `${agent.displayName} does not appear to be installed`, {
      details: { agent: agent.id, path: agent.configPath() },
      hint: `expected its configuration directory near ${agent.configPath()}`,
    });
  }

  const path = agent.configPath();
  const existing = readTextIfExists(path);

  // Every failure — unknown id, missing surface, unreferenceable secret —
  // happens here, before anything is written.
  const plan = await buildApplyPlan({
    config: options.config,
    registry: options.registry,
    agent,
    overrides: options.overrides,
    existing,
  });

  const rendered = await agent.render(plan);
  const unchanged = existing !== null && existing === rendered.content;

  if (options.dryRun) {
    return {
      agent: agent.id,
      path: rendered.path,
      content: rendered.content,
      backup: null,
      written: false,
      unchanged,
      warnings: rendered.warnings,
      roles: plan.roles,
    };
  }

  if (unchanged) {
    // Idempotent: a second run changes nothing, so it makes no backup either.
    return {
      agent: agent.id,
      path: rendered.path,
      content: rendered.content,
      backup: null,
      written: false,
      unchanged: true,
      warnings: rendered.warnings,
      roles: plan.roles,
    };
  }

  const backup = backupFile(rendered.path);
  writeTextFile(rendered.path, rendered.content);
  return {
    agent: agent.id,
    path: rendered.path,
    content: rendered.content,
    backup,
    written: true,
    unchanged: false,
    warnings: rendered.warnings,
    roles: plan.roles,
  };
};
