import { generateServerKey } from '@llm-runtime-dock/core';
import type { CliContext } from '../context.js';

/**
 * `lrd key generate` (spec §27, §28).
 *
 * Generates the gateway's own inbound credential and wires `server.auth` to it,
 * in place — the same read/mutate/backup/write shape `probe --save` uses.
 */

export interface KeyGenerateOptions {
  /** `--env` (bare) defaults the name; `--env NAME` picks one. `undefined`/`false` means file mode. */
  readonly env?: string | boolean;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export const runKeyGenerate = async (
  context: CliContext,
  options: KeyGenerateOptions,
): Promise<void> => {
  const location = context.configLocation();
  const envMode = options.env !== undefined && options.env !== false;
  const envName = typeof options.env === 'string' ? options.env : undefined;

  const result = generateServerKey({
    location,
    mode: envMode ? 'env' : 'file',
    envName,
    force: options.force,
    dryRun: options.dryRun,
    logger: context.logger,
  });

  if (context.options.json) {
    context.json(result);
    return;
  }

  const theme = context.theme;
  context.out(`${theme.label('key:')} ${result.key}`);
  context.out(
    theme.warn('shown once — it is not stored in the YAML file and cannot be recovered later'),
  );
  if (result.mode === 'file') {
    context.out(`${theme.label('key file:')} ${theme.path(result.keyFilePath ?? '')}`);
  } else {
    context.out(`${theme.label('env var:')} ${theme.id(result.envName ?? '')}`);
    if (process.platform === 'win32') {
      context.out(theme.muted(`PowerShell: $env:${result.envName} = "${result.key}"`));
      context.out(theme.muted(`cmd.exe:    set ${result.envName}=${result.key}`));
    } else {
      context.out(theme.muted(`export ${result.envName}=${result.key}`));
    }
    context.out(
      theme.muted(
        'set this wherever the gateway actually runs — a shell profile, a systemd unit, or a Docker/Compose environment entry',
      ),
    );
  }

  if (options.dryRun) {
    context.out(theme.muted(`--- ${result.path} (dry run, nothing written) ---`));
    context.out(result.content.trimEnd());
    return;
  }
  if (result.backup) context.out(theme.muted(`backup: ${result.backup}`));
  context.out(`${theme.ok('wrote')} ${theme.path(result.path)}`);
};
