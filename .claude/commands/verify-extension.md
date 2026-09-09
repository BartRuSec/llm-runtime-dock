---
description: Run the full verification gauntlet for a new adapter or agent package
argument-hint: <package-name>
---

Verify the extension package $ARGUMENTS. Run these in order, cheapest first, and
stop at the first failure - each step's failure has a specific cause listed
below.

1. `pnpm install` - resolves the new `workspace:*` entry. If the package is not
   picked up, the entry is missing from the root `package.json`
   **devDependencies**.
2. `pnpm -r run build` - per-package `tsc`. This has to precede anything that
   resolves `@llm-runtime-dock/*`, because those resolve through `exports` to
   each package's `dist/`.
3. `pnpm --filter <package-name> run test` - the fastest signal on your own code.
4. `pnpm typecheck` - runs `scripts/sync-version.mjs --check` **before** any
   TypeScript. A failure naming package versions means the new package's
   `version` does not equal the root's; fix it with `pnpm run version:sync`,
   never by hand.
5. `pnpm lint` - catches the house style: a `function` declaration, a class, a
   method shorthand, `this`.
6. `pnpm format:check` - covers markdown too (`.prettierignore` lists only
   `dist/`, `node_modules/`, `*.tsbuildinfo`). If it reports files outside your
   change, that is pre-existing: fix only your own, with
   `npx prettier --write <your paths>`. A repo-wide `pnpm format` would bury
   your change in an unrelated diff.
7. `pnpm test` - build, every package's unit tests, then the root end-to-end
   suites.
8. Observable check: the new id actually reaches the CLI.
   - adapter: `pnpm dev -- probe` and `pnpm dev -- doctor`
   - agent: `pnpm dev -- apply --help`
9. Parity check. The set of places a new id belongs is the set of places an
   existing id appears. Compare the two:

   ```
   grep -rn "omlx" --include=*.ts packages src        # or "opencode" for an agent
   grep -rn "omlx" README.md CLAUDE.md docs examples
   ```

   Both greps are path-scoped on purpose: `.claude/` and `.opencode/` mention
   these ids too, and they are this repo's own tooling files, not code. Report
   any site the new id is missing from.

Report what passed, what failed, and the exact command output for any failure.
