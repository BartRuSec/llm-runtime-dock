import { defineConfig } from 'vitest/config';

/**
 * One config, shared by every project in the workspace.
 *
 * Vitest resolves `include` against the directory it runs in, and a package run
 * by `pnpm -r run test` inherits this file. So `tests/**` means each package's
 * own `tests/` when run there, and the root `tests/` — which holds only
 * end-to-end suites — when run from the repository root.
 *
 * Package tests import their own code from `../src`; the end-to-end suites
 * import workspace packages by name, resolving through pnpm's symlinks against
 * built output, so they exercise the real published entry points.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
