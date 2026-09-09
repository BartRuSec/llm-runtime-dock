import { Command } from 'commander';
import type { LogLevel } from '@llm-runtime-dock/core';
import { isCliError, isGatewayError } from '@llm-runtime-dock/core';
import type { CliDeps, GlobalOptions } from './context.js';
import { createCliContext } from './context.js';
import type { Theme } from './theme.js';
import { createTheme, resolveColor } from './theme.js';
import type { CliContext } from './context.js';
import { runApply } from './commands/apply.js';
import { runDoctor } from './commands/doctor.js';
import { runProbe } from './commands/probe.js';
import { runServe } from './commands/serve.js';
import { runLogs, runModels, runRuntimes, runStatus, runSwitch } from './commands/simple.js';

export * from './context.js';
export * from './theme.js';
export * from './output.js';
export * from './gateway-client.js';
export { runApply } from './commands/apply.js';
export { runDoctor } from './commands/doctor.js';
export { runProbe } from './commands/probe.js';
export { runServe } from './commands/serve.js';
export { runLogs, runModels, runRuntimes, runStatus, runSwitch } from './commands/simple.js';

/**
 * `lrd` (spec §27).
 *
 * The composition root supplies the adapters and agent integrations, which is
 * what keeps core free of concrete plugins (§6).
 */

export interface RunCliOptions extends CliDeps {
  readonly argv: readonly string[];
  readonly version?: string;
}

export const runCli = async (options: RunCliOptions): Promise<number> => {
  const program = new Command();
  let exitCode = 0;

  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const version = options.version ?? '0.0.0-dev';

  /**
   * Help is written while argv is still being consumed, so `program.opts()`
   * cannot be trusted yet: commander acts on `--help` the moment it reaches it,
   * and `lrd --help --no-color` never parses the second flag. Reading the raw
   * argv alongside the parsed options makes both orders behave the same.
   */
  const flagged = (flag: string): boolean => options.argv.includes(flag);
  const helpColor = (): boolean =>
    resolveColor({
      json: program.opts<{ json?: boolean }>().json === true || flagged('--json'),
      noColor: program.opts<{ color?: boolean }>().color === false || flagged('--no-color'),
      force: options.color,
      ownsStreams: options.stdout === undefined && options.stderr === undefined,
      env: options.env ?? process.env,
      isTty: process.stdout.isTTY === true,
    });

  // Styled unconditionally: commander asks `getOutHasColors` at write time —
  // after argv has been consumed — and strips the escapes itself when the
  // answer is no. That is the only hook that runs late enough to see the flags.
  const theme: Theme = createTheme(true);

  program
    // Commander writes its own help and parse errors; route them through the
    // injected writers so a caller controls every stream this function touches.
    .configureOutput({
      writeOut: (text) => stdout(text.replace(/\n$/, '')),
      writeErr: (text) => stderr(text.replace(/\n$/, '')),
      // Commander's own defaults read `process.stdout.isTTY` directly, which
      // would bypass `--no-color`, `NO_COLOR` and the injected writers.
      getOutHasColors: helpColor,
      getErrHasColors: helpColor,
    })
    .configureHelp({
      styleTitle: (title) => theme.heading(title),
      styleCommandText: (text) => theme.id(text),
      styleOptionTerm: (term) => theme.label(term),
      styleSubcommandTerm: (term) => theme.label(term),
      styleArgumentTerm: (term) => theme.label(term),
      styleDescriptionText: (text) => theme.muted(text),
    })
    .name('lrd')
    .description('local LLM gateway and runtime lifecycle manager')
    // Commander prints this string verbatim, so `--version` says which binary
    // answered, not just a bare number.
    .version(`lrd ${version}`)
    // Applied to subcommand help too, which is wanted: `lrd probe --help` in a
    // bug report should say which version produced it.
    .addHelpText('beforeAll', `${theme.heading(`lrd ${version}`)}\n`)
    .option('--config <path>', 'explicit configuration file')
    .option('--json', 'machine-readable output')
    .option('--no-color', 'never colourise output')
    .option('--endpoint <url>', 'gateway endpoint for commands that need a running gateway')
    .option('--log-level <level>', 'debug | info | warn | error', 'info')
    .enablePositionalOptions()
    .exitOverride();

  /**
   * `--config` and `--json` are accepted by every command, and `--endpoint` by
   * the ones that talk to a running gateway (§27). Declaring them per command as
   * well as globally means they work on either side of the subcommand name.
   */
  const shared = (command: Command, withEndpoint = false): Command => {
    command
      .option('--config <path>', 'explicit configuration file')
      .option('--json', 'machine-readable output')
      .option('--no-color', 'never colourise output');
    if (withEndpoint) {
      command.option('--endpoint <url>', 'gateway endpoint (default: the configured server)');
    }
    return command;
  };

  const contextFor = (command: Command): CliContext => {
    const globals = program.opts<{
      config?: string;
      json?: boolean;
      color?: boolean;
      endpoint?: string;
      logLevel?: string;
    }>();
    const local = command.optsWithGlobals<{
      config?: string;
      json?: boolean;
      color?: boolean;
      endpoint?: string;
    }>();
    const merged: GlobalOptions = {
      config: local.config ?? globals.config,
      json: local.json ?? globals.json,
      endpoint: local.endpoint ?? globals.endpoint,
      logLevel: (globals.logLevel as LogLevel | undefined) ?? 'info',
      // A negated option defaults to `true`, so `??` would never see the one
      // that was actually passed: either side saying `false` has to win.
      noColor: local.color === false || globals.color === false,
    };
    return createCliContext({ ...options, version }, merged);
  };

  shared(program.command('serve'))
    .description('start the gateway')
    .option('--host <host>', 'bind address (default: from configuration)')
    .option('--port <port>', 'bind port (default: from configuration)', (value) => Number(value))
    .option('--debug', 'capture every proxied request and response to an NDJSON file')
    .option('--debug-dir <path>', 'where --debug writes (default: a temp subdirectory)')
    .action(
      async (
        local: { host?: string; port?: number; debug?: boolean; debugDir?: string },
        command: Command,
      ) => {
        await runServe(contextFor(command), local);
      },
    );

  shared(program.command('status'), true)
    .description('ask a running gateway what it is doing')
    .action(async (_local: unknown, command: Command) => {
      await runStatus(contextFor(command));
    });

  shared(program.command('probe'))
    .alias('discovery')
    .argument('[runtime]', 'probe one runtime or adapter instead of every known one')
    .description('ask the backends themselves what they serve')
    .option('--url <url>', "endpoint to probe instead of the runtime's or adapter's default")
    .option('--host <host>', 'override the host for a single probe target')
    .option('--port <port>', 'override the port for a single probe target', Number)
    .option('--api-key-env <VAR>', 'credential for runtimes that require one')
    .option('--interactive', 'ask per runtime what to probe, then offer to save')
    .option('--start', 'bring up a backend the probe found down, then probe again')
    .option('--save', "refresh this runtime's entries from what was found")
    .option('--dry-run', 'with --save: print the result and any conflicts, write nothing')
    .option('--force', 'with --save: remove configured models the probe did not find, unasked')
    .action(
      async (
        runtime: string | undefined,
        local: {
          url?: string;
          host?: string;
          port?: number;
          apiKeyEnv?: string;
          interactive?: boolean;
          start?: boolean;
          save?: boolean;
          dryRun?: boolean;
          force?: boolean;
        },
        command: Command,
      ) => {
        await runProbe(contextFor(command), runtime, local);
      },
    );

  shared(program.command('apply'))
    .argument('[agent]', 'opencode | claude | codex')
    .description("write the gateway into a coding agent's own configuration")
    .option('--all', 'apply to every agent present in the agents: section')
    .option('--dry-run', 'print the resulting configuration, write nothing')
    .option('--opus <model>', 'override the Claude Code opus role for one run')
    .option('--sonnet <model>', 'override the Claude Code sonnet role for one run')
    .option('--haiku <model>', 'override the Claude Code haiku role for one run')
    .option('--model <model>', 'override the Codex/OpenCode model for one run')
    .action(
      async (
        agent: string | undefined,
        local: {
          all?: boolean;
          dryRun?: boolean;
          opus?: string;
          sonnet?: string;
          haiku?: string;
          model?: string;
        },
        command: Command,
      ) => {
        exitCode = await runApply(contextFor(command), agent, local);
      },
    );

  shared(program.command('doctor'))
    .description('validate configuration, adapters, executables and agent roles')
    .action(async (_local: unknown, command: Command) => {
      exitCode = await runDoctor(contextFor(command));
    });

  shared(program.command('models'), true)
    .description('show configured logical model ids')
    .action(async (_local: unknown, command: Command) => {
      await runModels(contextFor(command));
    });

  shared(program.command('runtimes'), true)
    .description('show configured runtime instances and state')
    .action(async (_local: unknown, command: Command) => {
      await runRuntimes(contextFor(command));
    });

  shared(program.command('switch'), true)
    .argument('<model>', 'logical model id to make resident')
    .description('make a logical model id resident, through the scheduler')
    .action(async (model: string, _local: unknown, command: Command) => {
      await runSwitch(contextFor(command), model);
    });

  shared(program.command('logs'))
    .argument('<runtime>', 'logical model id')
    .description('show captured runtime process output')
    .action(async (runtime: string, _local: unknown, command: Command) => {
      await runLogs(contextFor(command), runtime);
    });

  try {
    await program.parseAsync([...options.argv], { from: 'user' });
  } catch (error) {
    return reportError(error, stderr, createTheme(helpColor()));
  }
  return exitCode;
};

/**
 * CLI errors exit non-zero with a readable message. Gateway errors can reach the
 * CLI only through an in-process service (`serve`), and are reported the same
 * way rather than being turned into an HTTP response.
 */
const reportError = (error: unknown, stderr: (line: string) => void, theme: Theme): number => {
  if (isCommanderExit(error)) return error.exitCode;

  if (isCliError(error) || isGatewayError(error)) {
    stderr(`${theme.danger(`error [${error.code}]`)} ${error.message}`);
    if (error.hint) stderr(theme.muted(`hint: ${error.hint}`));
    return 1;
  }
  stderr(`${theme.danger('error:')} ${error instanceof Error ? error.message : String(error)}`);
  return 1;
};

interface CommanderExit {
  readonly code: string;
  readonly exitCode: number;
}

const isCommanderExit = (error: unknown): error is CommanderExit => {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('commander.')
  );
};
