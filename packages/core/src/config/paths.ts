import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Configuration file resolution (spec §12). The first existing match wins. */

export interface ConfigLocation {
  /** The file that will be read, or the default target when nothing exists. */
  readonly path: string;
  readonly found: boolean;
  /** Every location that was considered, in order. */
  readonly candidates: readonly string[];
  /** Which rule produced `path`. */
  readonly source: 'flag' | 'env' | 'project' | 'xdg' | 'home' | 'default';
}

export const homeConfigPath = (): string => {
  return join(homedir(), '.config', 'llm-runtime-dock', 'config.yaml');
};

export interface ResolveConfigOptions {
  /** `--config <path>`. Honoured even when the file does not exist, so the error names it. */
  readonly explicitPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export const resolveConfigLocation = (options: ResolveConfigOptions = {}): ConfigLocation => {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (options.explicitPath) {
    const path = resolve(cwd, options.explicitPath);
    return { path, found: existsSync(path), candidates: [path], source: 'flag' };
  }

  const ordered: Array<{ path: string; source: ConfigLocation['source'] }> = [];
  if (env.LRD_CONFIG) ordered.push({ path: resolve(cwd, env.LRD_CONFIG), source: 'env' });
  ordered.push({ path: join(cwd, 'llm-runtime-dock.yaml'), source: 'project' });
  if (env.XDG_CONFIG_HOME) {
    ordered.push({
      path: join(env.XDG_CONFIG_HOME, 'llm-runtime-dock', 'config.yaml'),
      source: 'xdg',
    });
  }
  ordered.push({ path: homeConfigPath(), source: 'home' });

  const candidates = ordered.map((entry) => entry.path);
  for (const entry of ordered) {
    if (existsSync(entry.path)) {
      return { path: entry.path, found: true, candidates, source: entry.source };
    }
  }
  // Nothing exists yet. Writers create the home config; readers report this path
  // as the one they looked for last.
  return { path: homeConfigPath(), found: false, candidates, source: 'default' };
};

/**
 * Where a config-writing command should write (§12): the file resolution
 * actually found, or the home config when nothing exists.
 */
export const configWriteTarget = (location: ConfigLocation): string => {
  return location.found ? location.path : homeConfigPath();
};
