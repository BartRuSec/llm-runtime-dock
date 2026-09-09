import type {
  AdapterRegistry,
  AgentIntegration,
  AgentRegistry,
  ConfigLocation,
  DockConfig,
  LogLevel,
  Logger,
  RuntimeAdapter,
} from '@llm-runtime-dock/core';
import type {
  AssignmentPrompt,
  ProbePrompt,
  ProbeSavePrompt,
  RemovalPrompt,
  RolePrompt,
} from './prompt.js';
import type { Theme } from './theme.js';
import { createTheme, resolveColor } from './theme.js';
import {
  canPrompt,
  interactiveProbePrompt,
  interactiveProbeSavePrompt,
  interactiveAssignmentPrompt,
  interactiveRemovalPrompt,
  interactiveRolePrompt,
} from './prompt.js';
import {
  cliError,
  createAdapterRegistry,
  createAgentRegistry,
  createLogger,
  loadConfig,
  resolveConfigLocation,
} from '@llm-runtime-dock/core';

/**
 * Shared CLI plumbing (spec §27).
 *
 * The CLI is a client, not a second implementation: `serve`, `doctor` and
 * `probe` call the same core services the gateway uses, and no orchestration
 * logic lives in a command handler.
 */

export interface GlobalOptions {
  readonly config?: string;
  readonly json?: boolean;
  readonly endpoint?: string;
  readonly logLevel?: LogLevel;
  /** `--no-color`: never emit escape sequences, whatever the terminal is. */
  readonly noColor?: boolean;
}

export interface CliDeps {
  readonly adapters: readonly RuntimeAdapter[];
  readonly agents: readonly AgentIntegration[];
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Asks which model a role should use. Injected so tests, `--json` runs and
   * pipelines never reach a real terminal; defaults to the inquirer prompt.
   */
  readonly rolePrompt?: RolePrompt;
  /**
   * Asks which configured models a probe may delete. Injected for the same
   * reason as `rolePrompt`; defaults to the inquirer checkbox.
   */
  readonly removalPrompt?: RemovalPrompt;
  readonly assignmentPrompt?: AssignmentPrompt;
  /**
   * Asks which runtimes `lrd probe --interactive` should probe, and with what.
   * Injected for the same reason as `rolePrompt`.
   */
  readonly probePrompt?: ProbePrompt;
  /** Asks whether an interactive probe may write what it found. */
  readonly probeSavePrompt?: ProbeSavePrompt;
  /**
   * The version to report. Supplied by the composition root from
   * `__LRD_VERSION__`, which may only be referenced there (see `src/globals.d.ts`).
   */
  readonly version?: string;
  /**
   * Forces colour on or off. Only tests pass this; a real run derives it from
   * the flags, the environment and whether it owns the streams at all.
   */
  readonly color?: boolean;
}

export interface CliContext {
  readonly adapters: AdapterRegistry;
  readonly agents: AgentRegistry;
  readonly options: GlobalOptions;
  readonly logger: Logger;
  /** Terminal styling. Already a no-op when this run must stay plain. */
  readonly theme: Theme;
  readonly version: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  out(line: string): void;
  err(line: string): void;
  /** Print machine-readable output when `--json` was passed. */
  json(value: unknown): void;
  configLocation(): ConfigLocation;
  /**
   * Load configuration and report which file it came from (§12).
   *
   * `quiet` suppresses that report, for a command that prints the same path as
   * part of an aligned block of its own — `serve` is the only one.
   */
  loadConfig(options?: { readonly quiet?: boolean }): DockConfig;
  /** The base URL of a running gateway: `--endpoint`, else the configured one. */
  gatewayEndpoint(config?: DockConfig): string;
  agent(id: string): AgentIntegration;
  /**
   * Ask which model a role should use, or `null` when this run cannot ask —
   * no terminal, or `--json` was passed.
   */
  readonly rolePrompt: RolePrompt | null;
  /**
   * Ask which stale entries `probe --save` may delete, or `null` when this run
   * cannot ask — in which case they are kept (§22).
   */
  readonly removalPrompt: RemovalPrompt | null;
  /** Asks which runtime owns a model several offered; `null` when nothing can ask. */
  readonly assignmentPrompt: AssignmentPrompt | null;
  /**
   * Ask what to probe, or `null` when this run cannot ask. Unlike removal, an
   * interactive probe has no useful fallback, so `--interactive` fails rather
   * than quietly probing the defaults (§22).
   */
  readonly probePrompt: ProbePrompt | null;
  readonly probeSavePrompt: ProbeSavePrompt | null;
}

export const createCliContext = (deps: CliDeps, options: GlobalOptions): CliContext => {
  const adapters = createAdapterRegistry(deps.adapters);
  const agents = createAgentRegistry(deps.agents);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  const out = (line: string): void =>
    (deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`)))(line);
  const err = (line: string): void =>
    (deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);

  // Decided once, here, and handed to commands as `theme`. Injected writers
  // mean this run does not own the streams, so it stays plain — which is also
  // why no test in this repository has to know that colour exists.
  const theme = createTheme(
    resolveColor({
      json: options.json,
      noColor: options.noColor,
      force: deps.color,
      ownsStreams: deps.stdout === undefined && deps.stderr === undefined,
      env,
      isTty: process.stdout.isTTY === true,
    }),
  );

  const logger = createLogger({
    level: options.logLevel ?? 'info',
    format: options.json ? 'json' : 'pretty',
    write: (line) => err(line),
    palette: {
      time: theme.muted,
      level: (level, text) =>
        level === 'error'
          ? theme.danger(text)
          : level === 'warn'
            ? theme.warn(text)
            : level === 'debug'
              ? theme.muted(text)
              : theme.label(text),
      message: (text) => text,
      fields: theme.muted,
    },
  });

  return {
    adapters,
    agents,
    options,
    logger,
    theme,
    version: deps.version ?? '0.0.0-dev',
    env,
    cwd,
    out,
    err,
    json: (value) => out(JSON.stringify(value, null, 2)),

    configLocation: () => resolveConfigLocation({ explicitPath: options.config, cwd, env }),

    loadConfig: (loadOptions) => {
      const config = loadConfig(adapters, { explicitPath: options.config, cwd, env });
      if (!options.json && loadOptions?.quiet !== true) {
        err(`${theme.label('config:')} ${theme.path(config.location.path)}`);
      }
      return config;
    },

    gatewayEndpoint: (config) => {
      if (options.endpoint) return options.endpoint.replace(/\/+$/, '');
      if (config) return `http://${config.server.host}:${config.server.port}`;
      return 'http://127.0.0.1:8787';
    },

    rolePrompt: deps.rolePrompt ?? (canPrompt(options.json) ? interactiveRolePrompt : null),

    removalPrompt:
      deps.removalPrompt ?? (canPrompt(options.json) ? interactiveRemovalPrompt : null),
    assignmentPrompt:
      deps.assignmentPrompt ?? (canPrompt(options.json) ? interactiveAssignmentPrompt : null),

    probePrompt: deps.probePrompt ?? (canPrompt(options.json) ? interactiveProbePrompt : null),

    probeSavePrompt:
      deps.probeSavePrompt ?? (canPrompt(options.json) ? interactiveProbeSavePrompt : null),

    agent: (id) => {
      if (!agents.has(id)) {
        throw cliError('CONFIG_INVALID', `unknown coding agent "${id}"`, {
          hint: `known agents: ${agents.ids().join(', ')}`,
        });
      }
      return agents.get(id);
    },
  };
};
