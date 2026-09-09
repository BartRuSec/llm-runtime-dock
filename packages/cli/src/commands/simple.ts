import type { DockConfig, GatewayStatus } from '@llm-runtime-dock/core';
import { cliError } from '@llm-runtime-dock/core';
import type { CliContext } from '../context.js';
import { fetchStatus, requestSwitch } from '../gateway-client.js';
import { columns, keyValue, labelWidth } from '../output.js';

/** The read-only and gateway-client commands (spec §27). */

/** `lrd status` — asks a running gateway what it is doing, via `GET /status`. */
export const runStatus = async (context: CliContext): Promise<void> => {
  const config = tryLoadConfig(context);
  const endpoint = context.gatewayEndpoint(config ?? undefined);
  const status = await fetchStatus(endpoint);

  if (context.options.json) {
    context.json(status);
    return;
  }
  printStatus(context, endpoint, status);
};

/** `lrd switch <model>` — through `POST /switch`, which goes via the scheduler. */
export const runSwitch = async (context: CliContext, model: string): Promise<void> => {
  const config = tryLoadConfig(context);
  const endpoint = context.gatewayEndpoint(config ?? undefined);
  const status = await requestSwitch(endpoint, model);

  if (context.options.json) {
    context.json(status);
    return;
  }
  context.out(`${context.theme.ok('switched to')} ${context.theme.id(model)}`);
  printStatus(context, endpoint, status);
};

/** `lrd models` — configured logical ids with adapter, backend model and state. */
export const runModels = async (context: CliContext): Promise<void> => {
  const config = context.loadConfig();
  const state = await liveState(context, config);

  const rows = [...config.models.entries()].map(([id, instance]) => ({
    id,
    // The runtime is what the entry names; the adapter is a property of that
    // runtime, and is shown because it says how a switch will behave.
    runtime: instance.runtimeId,
    adapter: instance.adapterId,
    backend_model: instance.backendModel,
    // A kept entry is loaded even while another model is serving, so the
    // rotating occupant alone cannot answer "is this in memory" (§8).
    state: stateOf(state, id),
    // Its own column rather than a STATE value: `state` is a lifecycle value
    // the runtime reports, `disabled` is a fact about the configuration (§12).
    disabled: instance.disabled,
  }));

  if (context.options.json) {
    context.json(rows);
    return;
  }
  if (rows.length === 0) {
    context.out(context.theme.muted('no models configured'));
    return;
  }
  const theme = context.theme;
  for (const line of columns(
    ['MODEL', 'RUNTIME', 'ADAPTER', 'BACKEND MODEL', 'STATE', 'DISABLED'],
    rows.map((row) => [
      row.id,
      row.runtime,
      row.adapter,
      row.backend_model,
      row.state,
      row.disabled ? 'yes' : '-',
    ]),
    [theme.id, undefined, undefined, theme.muted, theme.state, theme.muted],
    theme.heading,
  )) {
    context.out(line);
  }
};

/**
 * `lrd runtimes` — the declared `runtimes:` section and its state.
 *
 * `models` answers "what can a client ask for"; this answers "what would be
 * started, where, and how is its slot freed".
 */
export const runRuntimes = async (context: CliContext): Promise<void> => {
  const config = context.loadConfig();
  const state = await liveState(context, config);

  // The declared `runtimes:` section, not something derived from `models:`: a
  // runtime with no models on it is legal, and is the first thing
  // `probe --save` writes.
  const rows = [...config.runtimes.values()].map((runtime) => {
    const adapter = context.adapters.get(runtime.adapterId);
    const resident = loadedEntries(state).find((entry) => runtime.models.includes(entry.modelId));
    return {
      id: runtime.id,
      adapter: adapter.id,
      endpoint:
        runtime.port === undefined ? "(the adapter's default)" : `${runtime.host}:${runtime.port}`,
      models: runtime.models.join(', ') || '(none)',
      release: adapter.modelRelease,
      state: resident ? resident.state : 'stopped',
      ownership: resident ? resident.ownership : '-',
      discovery: runtime.discovery,
    };
  });

  if (context.options.json) {
    context.json(rows);
    return;
  }
  if (rows.length === 0) {
    context.out(context.theme.muted('no runtimes configured'));
    return;
  }
  const theme = context.theme;
  const labels = ['adapter', 'endpoint', 'models', 'release', 'state', 'ownership', 'discovery'];
  const width = labelWidth(labels);
  const field = (label: string, value: string, style?: (text: string) => string): string =>
    `  ${keyValue(label, value, width, { label: theme.label, value: style })}`;

  for (const row of rows) {
    context.out(
      [
        theme.id(row.id),
        field('adapter', row.adapter),
        field('endpoint', row.endpoint, row.endpoint.startsWith('(') ? theme.muted : undefined),
        field('models', row.models, row.models === '(none)' ? theme.muted : undefined),
        field('release', row.release),
        field('state', row.state, theme.state),
        field('ownership', row.ownership),
        // Only when it is off: this is the one view of the `runtimes:` section
        // as configured, so it is where a reader looks to find out why a runtime
        // never shows up in a probe. Saying "on" for every other runtime would
        // be noise.
        ...(row.discovery ? [] : [field('discovery', 'off', theme.muted)]),
      ].join('\n'),
    );
  }
};

/**
 * `lrd logs <runtime>` — process output where the adapter spawned something.
 *
 * Logs live in the gateway process that spawned the runtime, so this reports
 * only what an in-process adapter retained. A runtime the gateway attached to
 * has no output of its own to show, and that is said plainly rather than faked.
 */
export const runLogs = async (context: CliContext, runtimeId: string): Promise<void> => {
  const config = context.loadConfig();
  const instance = config.models.get(runtimeId);
  if (!instance) {
    throw cliError('CONFIG_INVALID', `unknown model id "${runtimeId}"`, {
      details: { model: runtimeId, known: [...config.models.keys()] },
      hint: `configured model ids: ${[...config.models.keys()].join(', ') || '(none)'}`,
    });
  }
  const adapter = context.adapters.get(instance.adapterId);
  const lines = adapter.logs?.(instance) ?? [];

  if (context.options.json) {
    context.json({ runtime: runtimeId, adapter: adapter.id, lines });
    return;
  }
  if (lines.length === 0) {
    // Process handles live in the `serve` process, so a separate `lrd logs`
    // invocation has none of them. Say that rather than implying the runtime
    // produced no output.
    context.out(
      `no captured output for "${runtimeId}": runtime process output is held by the running gateway, not by this command`,
    );
    context.out(
      context.theme.muted(
        `follow the output of \`lrd serve\` instead, or check ${adapter.id}'s own logs`,
      ),
    );
    return;
  }
  for (const line of lines) context.out(line);
};

const tryLoadConfig = (context: CliContext): ReturnType<CliContext['loadConfig']> | null => {
  // `status` and `switch` must work against `--endpoint` even with no config.
  // Quietly: the block below prints a `config:` row of its own, and that one is
  // the path the *gateway* reported rather than the one resolved here.
  try {
    return context.loadConfig({ quiet: true });
  } catch {
    return null;
  }
};

/**
 * State from a running gateway, if one answers. `models` and `runtimes` work
 * without a gateway — they just report `stopped` for everything.
 */
/**
 * Every entry the gateway is holding in memory: the rotating occupant plus
 * anything `keep_resident` is keeping alongside it (§8).
 *
 * `status.resident` alone is not the whole answer: a kept model would be
 * reported as `stopped` while sitting in memory.
 */
const loadedEntries = (status: GatewayStatus | null) => [
  ...(status?.resident ? [status.resident] : []),
  ...(status?.kept ?? []),
];

const stateOf = (status: GatewayStatus | null, modelId: string): string =>
  loadedEntries(status).find((entry) => entry.modelId === modelId)?.state ?? 'stopped';

const liveState = async (
  context: CliContext,
  config: DockConfig,
): Promise<GatewayStatus | null> => {
  try {
    return await fetchStatus(context.gatewayEndpoint(config));
  } catch {
    return null;
  }
};

/**
 * The block documented in §27. Labels are lower case, like every other report
 * this CLI prints — `serve` and `runtimes` use the same shape.
 */
const printStatus = (context: CliContext, endpoint: string, status: GatewayStatus): void => {
  const theme = context.theme;
  const width = labelWidth([
    'gateway',
    'config',
    'resident',
    'model',
    'release',
    'state',
    'kept',
    'serving',
    'queue',
  ]);
  const line = (label: string, value: string, style?: (text: string) => string): void =>
    context.out(keyValue(label, value, width, { label: theme.label, value: style }));

  line('gateway', `${theme.ok('running at')} ${theme.url(endpoint)}`);
  // The path the gateway reported, which is not necessarily the one this
  // process would resolve — which is why it is worth printing at all.
  line('config', status.configPath, theme.path);
  if (status.resident) {
    // With a kept entry alongside it the occupant may be loaded but not
    // answering, and `resident: X` right after `switched to Y` reads as a
    // contradiction unless it says which one it is.
    const idle = status.serving !== null && status.serving !== status.resident.modelId;
    line(
      'resident',
      `${theme.id(status.resident.modelId)} (${status.resident.adapter}, ${status.resident.ownership})${
        idle ? ' — loaded, not serving' : ''
      }`,
    );
    line('model', status.resident.backendModel);
    line('release', status.resident.modelRelease);
    line('state', status.resident.state, theme.state);
  } else {
    line('resident', 'none', theme.muted);
  }
  // Where the rest of the memory went (§8, §26). One row can only speak for the
  // rotating occupant, and `keep_resident` puts other models alongside it.
  if (status.kept.length > 0) {
    for (const entry of status.kept) {
      line(
        'kept',
        `${theme.id(entry.modelId)} (${entry.adapter}, ${entry.state}, ${entry.activeRequests} active)`,
      );
    }
    line('serving', status.serving ?? 'none', status.serving ? theme.id : theme.muted);
  }
  line('queue', String(status.queueDepth));
};
