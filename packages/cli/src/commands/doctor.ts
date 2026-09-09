import type { DockConfig, RuntimeInstance, Surface } from '@llm-runtime-dock/core';
import {
  configuredRoles,
  createProcessExecutor,
  executableAvailable,
  isCliError,
} from '@llm-runtime-dock/core';
import type { CliContext } from '../context.js';

/**
 * `lrd doctor` (spec §27).
 *
 * Validates configuration and reports the problems that would otherwise surface
 * as a failed switch or a coding agent pointed at nothing.
 */

interface Finding {
  readonly level: 'ok' | 'warn' | 'error';
  readonly message: string;
}

export const runDoctor = async (context: CliContext): Promise<number> => {
  const findings: Finding[] = [];

  let config: DockConfig;
  try {
    config = context.loadConfig();
  } catch (error) {
    // Configuration errors reach the gateway too — it refuses to start on them —
    // but they are reported here, at load time.
    const message = error instanceof Error ? error.message : String(error);
    const code = isCliError(error) ? error.code : 'CONFIG_INVALID';
    context.out(`${context.theme.level('error', 'error')}  [${code}] ${message}`);
    if (isCliError(error) && error.hint) {
      context.out(context.theme.muted(`       hint: ${error.hint}`));
    }
    return 1;
  }

  findings.push({ level: 'ok', message: `configuration loaded from ${config.location.path}` });

  if (config.models.size === 0) {
    findings.push({
      level: 'warn',
      message: 'no models configured; run `lrd probe <runtime> --save` to discover some',
    });
  }

  // Once per declared runtime rather than once per model: server-scoped options
  // live on the runtime now, so every model on it would repeat the same warning.
  for (const runtime of config.runtimes.values()) {
    const adapter = context.adapters.get(runtime.adapterId);
    const enabled = runtime.models.filter((id) => config.models.get(id)?.disabled !== true);
    if (runtime.models.length === 0) {
      // Not an error: `probe --save` writes a runtime before anything is loaded,
      // and a backend that is merely off is the normal state of a laptop.
      findings.push({
        level: 'warn',
        message: `runtimes.${runtime.id}: declared, but no model names it`,
      });
    } else if (enabled.length === 0) {
      // Every entry on it is disabled, so nothing below reports on this runtime
      // at all — its models skip the endpoint and executable checks. Say it is
      // inert rather than letting it disappear from the report (§12).
      findings.push({
        level: 'warn',
        message: `runtimes.${runtime.id}: every model on it is disabled, so nothing will ever start it`,
      });
    }

    if (!runtime.discovery) {
      // A runtime that no sweep will ever look at should not have to be
      // discovered by reading the YAML. It is a statement of intent, not a
      // problem, so it is reported at `ok` (§22).
      findings.push({
        level: 'ok',
        message: `runtimes.${runtime.id}: discovery is off — managed by hand, and \`lrd probe\` skips it unless named`,
      });
    }

    // Server-scoped options only take effect when the gateway spawns the server.
    if (adapter.serverScopedOptionKeys.length > 0) {
      const declared = adapter.serverScopedOptionKeys.filter(
        (key) => (runtime.raw.options as Record<string, unknown> | undefined)?.[key] !== undefined,
      );
      if (declared.length > 0) {
        findings.push({
          level: 'warn',
          message: `runtimes.${runtime.id}: ${declared.join(', ')} configure the server and are ignored when the gateway attaches to a running one`,
        });
      }
    }
  }

  for (const [id, instance] of config.models) {
    const adapter = context.adapters.get(instance.adapterId);
    if (instance.disabled) {
      // Configuration, not catalogue (§12). Nothing will route to it, so
      // probing its server or looking for its executable would report on a
      // switch that cannot happen.
      findings.push({
        level: 'ok',
        message: `models.${id}: disabled — not advertised on /v1/models, not routable, not written into agent configs`,
      });
      continue;
    }
    findings.push({
      level: 'ok',
      message: `models.${id}: ${instance.runtimeId} (${adapter.id}) → ${instance.backendModel} (release: ${adapter.modelRelease})${
        instance.keepResident ? ' — kept resident, never unloaded by a switch' : ''
      }`,
    });

    findings.push(...(await checkEndpoint(context, id, instance)));
  }

  findings.push(...checkKeptResident(config));

  findings.push(...(await checkExecutables(context, config)));
  findings.push(...(await checkAgents(context, config)));

  if (context.options.json) {
    context.json(findings);
  } else {
    for (const finding of findings) {
      // ASCII levels, coloured — a legacy Windows console mangles ✔/⚠/✖, and
      // padding has to happen before the colour or the column shifts.
      context.out(
        `${context.theme.level(finding.level, finding.level.padEnd(5))}  ${finding.message}`,
      );
    }
  }
  return findings.some((finding) => finding.level === 'error') ? 1 : 0;
};

/**
 * `keep_resident` trades the one-model memory guarantee for warm switching (§8),
 * and each extra kept entry spends more of a single memory pool. The config
 * check rejects the case that cannot work at all; this reports the case that
 * merely costs memory, so it is a warning rather than an error.
 */
const checkKeptResident = (config: DockConfig): Finding[] => {
  const findings: Finding[] = [];

  // A disabled entry is never loaded, so the flag on it does nothing. Not an
  // error — disabling a kept model for a while is a normal thing to do — but
  // worth saying, because the flag reads as if it were still in force.
  const inert = [...config.models.entries()].filter(
    ([, instance]) => instance.keepResident && instance.disabled,
  );
  for (const [id] of inert) {
    findings.push({
      level: 'warn',
      message: `models.${id}: keep_resident has no effect while the entry is disabled`,
    });
  }

  const kept = [...config.models.entries()].filter(
    ([, instance]) => instance.keepResident && !instance.disabled,
  );
  if (kept.length > 1) {
    findings.push({
      level: 'warn',
      message: `${kept.length} entries set keep_resident (${kept
        .map(([id]) => id)
        .join(', ')}) — all of them hold memory at once, on top of whichever model is rotating`,
    });
  }
  return findings;
};

const checkEndpoint = async (
  context: CliContext,
  id: string,
  instance: RuntimeInstance,
): Promise<Finding[]> => {
  const adapter = context.adapters.get(instance.adapterId);
  const findings: Finding[] = [];

  const health = await adapter.health(instance).catch(() => ({ state: 'unreachable' as const }));
  if (health.state === 'unreachable') {
    findings.push({
      level: 'ok',
      message: `models.${id}: no server answering yet (will be spawned on demand)`,
    });
    return findings;
  }

  findings.push({ level: 'ok', message: `models.${id}: a server is answering (${health.state})` });

  // Pinned models block the resident slot; report them before a switch fails (§20).
  // A model this entry itself keeps resident is the exception: the gateway is
  // not trying to evict it, so the runtime's own pin agrees with the config.
  try {
    for (const model of await adapter.listModels(instance)) {
      if (model.pinned === true && !(instance.keepResident && model.id === instance.backendModel)) {
        findings.push({
          level: 'warn',
          message: `models.${id}: "${model.id}" is pinned in ${adapter.id} and would block the resident slot`,
        });
      }
    }
  } catch (error) {
    findings.push({
      level: 'warn',
      message: `models.${id}: could not list models — ${(error as Error).message}`,
    });
  }
  return findings;
};

const checkAgents = async (context: CliContext, config: DockConfig): Promise<Finding[]> => {
  const findings: Finding[] = [];
  if (!config.agents) return findings;

  for (const agent of context.agents.list()) {
    const roles = configuredRoles(config, agent.id);
    if (Object.keys(roles).length === 0) continue;

    const installed = await agent.isInstalled();
    findings.push({
      level: installed ? 'ok' : 'warn',
      message: `${agent.displayName}: ${installed ? 'installed' : 'not installed'} (${agent.configPath()})`,
    });

    for (const [role, modelId] of Object.entries(roles)) {
      const instance = config.models.get(modelId);
      if (!instance) {
        findings.push({
          level: 'error',
          message: `agents.${agent.id}.${role} names unknown model id "${modelId}"`,
        });
        continue;
      }
      if (instance.disabled) {
        // Exactly what `lrd apply` refuses to write (§23), reported before the
        // apply rather than by it.
        findings.push({
          level: 'error',
          message: `agents.${agent.id}.${role} → "${modelId}" is disabled in configuration and is not served`,
        });
        continue;
      }
      const adapter = context.adapters.get(instance.adapterId);
      const capabilities = await adapter.capabilities(instance);
      if (!capabilities.surfaces.includes(agent.surface as Surface)) {
        findings.push({
          level: 'error',
          message: `agents.${agent.id}.${role} → "${modelId}" (${adapter.id}) does not serve the ${agent.surface} surface`,
        });
        continue;
      }
      if (instance.auth && !agent.supportsSecretReference) {
        findings.push({
          level: 'error',
          message: `agents.${agent.id}.${role} → "${modelId}" needs a credential that ${agent.displayName}'s format cannot reference`,
        });
        continue;
      }
      findings.push({ level: 'ok', message: `agents.${agent.id}.${role} → ${modelId}` });
    }
  }
  return findings;
};

/**
 * A missing executable is the most common reason a switch fails, so it is
 * reported here rather than on first request. Which binaries an entry needs is
 * adapter knowledge (§6).
 */
const checkExecutables = async (context: CliContext, config: DockConfig): Promise<Finding[]> => {
  const executor = createProcessExecutor();
  const findings: Finding[] = [];
  const seen = new Map<string, boolean>();

  for (const [id, instance] of config.models) {
    // Nothing spawns a disabled entry's server, so a missing binary for it is
    // not a finding (§12).
    if (instance.disabled) continue;
    const adapter = context.adapters.get(instance.adapterId);
    for (const command of new Set(adapter.requiredExecutables?.(instance) ?? [])) {
      let available = seen.get(command);
      if (available === undefined) {
        available = await executableAvailable(executor, command);
        seen.set(command, available);
      }
      findings.push({
        // A warning, not an error: ownership is decided at runtime (§8). An
        // entry that attaches to an already-running server never spawns
        // anything, so a missing binary only matters if a spawn is needed.
        level: available ? 'ok' : 'warn',
        message: available
          ? `models.${id}: executable "${command}" found`
          : `models.${id}: executable "${command}" not found on PATH (only needed if the gateway has to spawn the server)`,
      });
    }
  }
  return findings;
};
