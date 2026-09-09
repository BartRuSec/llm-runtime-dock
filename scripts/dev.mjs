#!/usr/bin/env node
// `pnpm dev -- <lrd command>`: build the workspace, then run the CLI from it.
//
// This runs the full `build`, bundle stage included, because `bin/lrd.mjs`
// loads the bundled `dist/index.js` — the same file that ships. `pnpm -r run
// build` alone would leave it stale, or absent on a clean checkout.
//
// This exists as a script rather than a shell one-liner so it behaves the same
// on Windows. It needs two things a package.json script cannot express portably:
// the build's output has to go to stderr so the CLI's stdout stays pipeable
// (`pnpm dev -- probe mtplx > snippet.yaml`), and the CLI's exit code has to
// propagate. `>&2` is not portable across cmd.exe and POSIX shells; this is.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lrd = fileURLToPath(new URL('../bin/lrd.mjs', import.meta.url));

/** Run a command, resolving with its exit code. `stdout: 'stderr'` diverts output. */
const run = (command, args, { stdout }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      // `shell: true` on Windows lets `pnpm` resolve through its .cmd shim.
      shell: process.platform === 'win32',
      stdio: ['inherit', stdout === 'stderr' ? 'pipe' : 'inherit', 'inherit'],
    });
    if (stdout === 'stderr' && child.stdout) child.stdout.pipe(process.stderr);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
};

const buildCode = await run('pnpm', ['run', 'build'], { stdout: 'stderr' });
if (buildCode !== 0) process.exit(buildCode);

process.exit(await run(process.execPath, [lrd, ...process.argv.slice(2)], { stdout: 'inherit' }));
