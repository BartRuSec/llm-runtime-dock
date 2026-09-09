# Agent integration checklist

## Find the sites, do not trust a list

```
grep -rn "opencode" --include=*.ts packages/core/src packages/cli/src src
grep -rn "opencode" README.md CLAUDE.md docs examples
```

Run both again at the end with your own id and compare. Both are path-scoped on
purpose: `.claude/` and `.opencode/` mention `opencode` too, and they are this
repo's own tooling files, not code.

## In the package - `packages/agents/<name>/`

- [ ] `package.json` - name `@llm-runtime-dock/agent-<name>`, `private: true`,
      `type: module`, `exports` pointing at `dist`, scripts
      `build`/`typecheck`/`clean`/`test`, `@llm-runtime-dock/core: workspace:*`
      plus whatever parser the target's format needs, devDeps `rimraf` +
      `vitest`. `version` equal to the root's.
- [ ] `tsconfig.json` - copied byte for byte from any sibling package.
- [ ] `src/index.ts` - the whole integration: one factory returning an object
      literal, plus private helpers as named consts.
- [ ] `tests/render.test.ts`.

There is no `options.ts` and no `config.ts` in an agent package.

## Outside the package

- [ ] `src/index.ts` (repository root) - one import, one entry in
      `defaultAgents`.
- [ ] Root `package.json` - `workspace:*` in **`devDependencies`**, then
      `pnpm install`.
- [ ] The five sites in `hardcoded-sites.md`: `agentsSchema`, `configuredRoles`,
      `configuredSettings`, the `check(...)` calls in `load.ts`, and
      `overridesFor` + `selectAgents` in `apply.ts`.
- [ ] `packages/cli/src/index.ts` - the `apply` argument description.

## Documentation

- [ ] `docs/08-agents.md` - the `requiresRoleMapping` table and a per-agent
      config-shape section.
- [ ] `README.md` - the coding-agents paragraph and the `lrd apply` examples.
- [ ] `examples/config.yaml` - the `agents:` block.
- [ ] `CLAUDE.md` - the Layout block.

## NOT required

- **No `pnpm-workspace.yaml` edit** - it already globs `packages/agents/*`.
- **No `scripts/sync-version.mjs` or `scripts/bundle.mjs` edit.**
- **No `tsconfig` `references`, no per-package `vitest.config.ts`.**
- **No change in `packages/core/src/agent-apply.ts`** - the write, the backup and
  the idempotency check are generic and already done.
- **No change in `apps/gateway`** - agents are a CLI-time concern.
- **No version bump.**
