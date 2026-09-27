import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Write a secret to disk with restrictive permissions, best effort.
 *
 * `mode` on `writeFileSync` only applies when the file is created; `chmodSync`
 * afterward covers the case where it already existed. Windows has no POSIX
 * permission bits, so a failure there is swallowed rather than surfaced.
 */
export const writeSecretFile = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort only — see above.
  }
};
