import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProcessExecutor, expandHome } from '../src/index.js';

/**
 * Cross-platform behaviour.
 *
 * The gateway targets Windows as well as Unix, so anything that touches paths,
 * executables or the shell has to be written for both.
 */

describe('home expansion', () => {
  it('accepts either separator after the tilde', () => {
    // A configuration file is portable, and `~/.some-runtime/api-key` is what
    // the README shows, whatever platform the reader is on.
    expect(expandHome('~/keys/api')).toBe(resolve(homedir(), 'keys/api'));
    expect(expandHome('~\\keys\\api')).toBe(resolve(homedir(), 'keys\\api'));
    expect(expandHome('~')).toBe(homedir());
  });

  it('leaves a path without a tilde as an absolute path', () => {
    expect(expandHome(join('some', 'relative'))).toBe(resolve(join('some', 'relative')));
  });

  it('does not treat a tilde inside a name as a home reference', () => {
    expect(expandHome('~notauser/keys')).toBe(resolve('~notauser/keys'));
  });
});

describe('executable lookup', () => {
  it('finds the running Node binary by name', async () => {
    // `which` on Unix, `where` on Windows — the executor picks per platform.
    const executor = createProcessExecutor();
    expect(await executor.which('node')).toBe(true);
    expect(await executor.which('definitely-not-an-executable-xyz')).toBe(false);
  });

  it('runs a command without a shell, so metacharacters stay literal', async () => {
    const executor = createProcessExecutor();
    const result = await executor.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', 'a b; c && d'],
    });
    expect(result.code).toBe(0);
    // One argument, not three commands.
    expect(result.stdout).toBe('a b; c && d');
  });

  it('reports a missing executable rather than hanging', async () => {
    const executor = createProcessExecutor();
    const managed = executor.spawn({
      command: join('definitely', 'not', 'a', 'real', 'binary'),
      args: [],
    });
    // A failed spawn emits `error` and never `exit`; the executor normalizes
    // that so a caller racing this promise does not wait out its timeout.
    await managed.exited;
    expect(managed.hasExited()).toBe(true);
    expect(managed.error()).toBeDefined();
  });
});
