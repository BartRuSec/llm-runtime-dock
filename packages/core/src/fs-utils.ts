import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** File helpers shared by the config writer and the agent apply path. */

export const readTextIfExists = (path: string): string | null => {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
};

/**
 * Copy `path` next to itself before it is overwritten. Both `probe --save` and
 * `apply` are destructive and must be recoverable (§22, §23).
 */
export const backupFile = (path: string, now: Date = new Date()): string | null => {
  if (!existsSync(path)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backup = `${path}.${stamp}.bak`;
  copyFileSync(path, backup);
  return backup;
};

export const writeTextFile = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
};
