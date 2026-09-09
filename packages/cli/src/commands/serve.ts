import { startGateway } from '@llm-runtime-dock/gateway';
import { createDebugTap, createDockService, servedModelIds } from '@llm-runtime-dock/core';
import type { DebugTap } from '@llm-runtime-dock/core';
import type { CliContext } from '../context.js';
import { keyValue, labelWidth } from '../output.js';

/**
 * `lrd serve` (spec §27). This is what a global install exists for.
 *
 * It builds the same `DockService` every other command uses; the HTTP layer is
 * the only thing this adds.
 */

export interface ServeOptions {
  readonly host?: string;
  readonly port?: number;
  /** Capture what this gateway forwards and receives, to an NDJSON file (§14). */
  readonly debug?: boolean;
  readonly debugDir?: string;
}

export const runServe = async (context: CliContext, options: ServeOptions = {}): Promise<void> => {
  // First line of the run, ahead of the config breadcrumb: on a global install
  // this is the only place that says which version answered. It goes to stderr
  // because stdout is the gateway's own report, and it is skipped under --json,
  // where stderr carries JSON log lines that have to stay parseable (§27).
  if (!context.options.json) context.err(context.theme.heading(`lrd ${context.version}`));

  // The gateway refuses to start on an invalid configuration (§25). Quietly,
  // because the config path is one row of the aligned block printed below
  // rather than a loose breadcrumb ahead of it.
  const config = context.loadConfig({ quiet: true });

  // One tap, shared by the service and the HTTP layer: the service sees the
  // upstream hop and the gateway sees what reached the client, and a capture of
  // only one of them could not show a difference between the two.
  const debugDir = options.debugDir ?? context.env.LRD_DEBUG_DIR;
  const debug = options.debug === true || isTruthy(context.env.LRD_DEBUG);
  const tap: DebugTap | null = debug
    ? createDebugTap({
        logger: context.logger,
        ...(debugDir ? { dir: debugDir } : {}),
      })
    : null;

  const service = createDockService({
    config,
    registry: context.adapters,
    logger: context.logger,
    ...(tap ? { tap } : {}),
  });

  const gateway = await startGateway({
    service,
    logger: context.logger,
    host: options.host ?? config.server.host,
    port: options.port ?? config.server.port,
    ...(tap ? { tap } : {}),
  });

  // Under --json stdout is the machine-readable surface, so this human report
  // is skipped rather than interleaved with it.
  if (!context.options.json) {
    const theme = context.theme;
    // One scheme for the whole block, the same one `status` prints: a styled
    // label, then a value styled by what it is. Prose lines and a bare-label
    // line mixed into this read as three different formats.
    const labels = ['config', 'endpoint', 'models'];
    const width = labelWidth(labels);
    const line = (label: string, value: string): void =>
      context.out(keyValue(label, value, width, { label: theme.label }));

    // What this gateway will answer for. A disabled entry is configuration
    // only, so listing it here would promise a route that returns 404 (§12).
    const models = servedModelIds(config);
    line('config', theme.path(config.location.path));
    line('endpoint', theme.url(gateway.url));
    line(
      'models',
      models.length > 0 ? models.map((id) => theme.id(id)).join(', ') : theme.muted('(none)'),
    );
  }
  if (tap) {
    // Said on stderr, every run, because the file holds whole conversations —
    // system prompts, file contents, anything an agent pasted in.
    context.err(`${context.theme.label('debug capture:')} ${context.theme.path(tap.path)}`);
    context.err(
      context.theme.warn(
        'it records full request and response bodies, including the entire conversation; treat the file as sensitive',
      ),
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second signal is the user saying the first one is taking too long.
      // Honour it, but say what it costs: nothing has released the runtimes
      // yet, so whatever is loaded stays loaded (§8).
      context.logger.warn('second signal: exiting without releasing the runtimes', {
        event: 'gateway.shutdown_forced',
        signal,
      });
      process.exit(1);
    }
    shuttingDown = true;
    // Through the logger, not `err` directly: under --json stderr is a stream
    // of JSON log lines and a bare sentence would break a consumer parsing it.
    context.logger.info('shutting down', { event: 'gateway.shutdown', signal });
    void gateway
      .close()
      .then(() => tap?.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  // `on`, not `once`: the second press has to reach the handler above, or the
  // only way out is a signal nothing can catch — which leaves every loaded
  // model behind.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Closing the terminal sends SIGHUP, whose default action is to terminate.
  // Without this, shutting the window orphans every runtime the gateway
  // started — they are its children, but nothing kills a child on macOS or
  // Linux when its parent dies.
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  // Windows does not deliver SIGTERM; Ctrl+Break arrives as SIGBREAK, so
  // without this a Windows user has no way to release the slot cleanly.
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  }

  // Resolve only when the process is told to stop.
  await new Promise<void>(() => {});
};

/**
 * `LRD_DEBUG=0` and `LRD_DEBUG=false` mean off.
 *
 * A bare presence check would make the documented way to switch the capture off
 * — setting it to a falsy value — switch it on instead, which is a bad surprise
 * for something that writes conversations to disk.
 */
const isTruthy = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off';
};
