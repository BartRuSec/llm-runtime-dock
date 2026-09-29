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
 *
 * A file this apply is about to write — or that already carries — the
 * gateway's own key in plaintext (§28: Claude Code always, OpenCode when the
 * key has no variable name to reference) still gets backed up like any other
 * file, but is flagged with a warning: the `.bak` is itself a plaintext copy
 * of the secret, and the caller is told so rather than finding out later.
 */

/** Matches `generateApiKey`'s own output — recognizable, not a generic secret scan. */
const LRD_KEY_PATTERN = /lrd_[A-Za-z0-9_-]{20,}/;

export interface ApplyAgentOptions {
  readonly config: DockConfig;
  readonly registry: AdapterRegistry;
  readonly agent: AgentIntegration;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly dryRun?: boolean;
  /** Skip the installed check. Only for tests against a temp directory. */
  readonly skipInstalledCheck?: boolean;
  /** Forwarded to `buildApplyPlan`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
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
    env: options.env,
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

  const embedsLiteralKey =
    (plan.gatewayApiKey !== undefined && rendered.content.includes(plan.gatewayApiKey)) ||
    (existing !== null && LRD_KEY_PATTERN.test(existing));

  const backup = backupFile(rendered.path);
  const warnings = embedsLiteralKey
    ? [
        ...rendered.warnings,
        backup
          ? `backup at ${backup} carries the gateway's own API key in plaintext — delete it once you no longer need the previous version`
          : `${rendered.path} carries the gateway's own API key in plaintext`,
      ]
    : rendered.warnings;
  writeTextFile(rendered.path, rendered.content);
  return {
    agent: agent.id,
    path: rendered.path,
    content: rendered.content,
    backup,
    written: true,
    unchanged: false,
    warnings,
    roles: plan.roles,
  };
};
