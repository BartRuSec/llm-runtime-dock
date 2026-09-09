# Adapter checklist

## Find the sites, do not trust a list

The set of places you must touch is exactly the set of places an existing
adapter id already appears. That is self-updating; a hand-maintained list of
file:line is not.

```
grep -rn "omlx" --include=*.ts packages src
grep -rn "omlx" README.md CLAUDE.md docs examples
```

Run both again at the end with your own id and compare. Anything the grep finds
that this checklist does not mention is a bug in this checklist - fix it.

## In the package - `packages/runtimes/<name>/`

- [ ] `package.json` - name `@llm-runtime-dock/adapter-<name>`, `private: true`,
      `type: module`, `exports` pointing at `dist`, scripts
      `build`/`typecheck`/`clean`/`test`, deps `zod` +
      `@llm-runtime-dock/core: workspace:*`, devDeps `rimraf` + `vitest`.
      `version` equal to the root's.
- [ ] `tsconfig.json` - copied byte for byte from any sibling package.
- [ ] `src/options.ts` - zod schema, `OPTION_SPECS`, `RESERVED_ARGS`,
      `SERVER_SCOPED_OPTION_KEYS`, `validate<Name>Options`, `render<Name>Args`.
      Import zod as `import * as z from 'zod'`, never `import { z }` - the
      named form defeats tree-shaking and adds 273 kB of unused locales to the
      published bundle. See CLAUDE.md, Packaging.
- [ ] `src/adapter.ts` - the closure factory, and a widened interface if you add
      public members.
- [ ] `src/index.ts` - the two-line barrel.
- [ ] `tests/options.test.ts`.

## Outside the package - exactly two files

- [ ] `src/index.ts` (repository root) - one import, one entry in
      `defaultAdapters`. This is the only file in the repo that may import a
      concrete adapter.
- [ ] Root `package.json` - `"@llm-runtime-dock/adapter-<name>": "workspace:*"`
      in **`devDependencies`**, then `pnpm install`.

## Documentation

- [ ] `docs/04-adapters.md` - a new `## <Name> Adapter` section.
- [ ] `docs/03-lifecycle.md` - the release-mechanism table and the
      identity-source table.
- [ ] `docs/07-discovery.md` - the default-probe-target table and the sample
      `lrd probe` output.
- [ ] `docs/02-architecture.md` - the directory tree and the package-name list.
- [ ] `docs/README.md` - the prose line that names the shipped adapters.
- [ ] `README.md` - the "What it works with" table and the `adapter` field's
      allowed values in the configuration table.
- [ ] `CLAUDE.md` - the Layout block.
- [ ] `examples/config.yaml` - a sample `runtimes:` entry plus a model naming it, if the adapter is worth showing. Give it a port no other entry in that file uses; two servers cannot share one.
- [ ] `docs/07-discovery.md` - the default-probe-target table, and a way for `probe()` to recognise your server if the port collides with an existing default.
- [ ] `docs/05-configuration.md` - only if the adapter adds a field to either table.

## NOT required - do not go looking for these

None of the following exist, and adding one would be a regression:

- **No union type of runtime kinds.** `packages/core/src/config/schema.ts` has
  `adapter: z.string()` on `runtimeEntrySchema`. Validation is a registry lookup at config-load time
  (`registry.require(...)`), which throws `CONFIG_INVALID` listing the known ids.
- **No `pnpm-workspace.yaml` edit.** It already globs `packages/runtimes/*`.
  (One exception: a _new third-party dependency_ whose only usable release is
  younger than the 14-day `minimumReleaseAge` - see CLAUDE.md, Dependency
  policy. Prefer widening the version floor; an exclude entry is a last resort
  and needs a comment saying why. Not needed for `zod` + core.)
- **No `scripts/sync-version.mjs` edit.** It discovers packages by reading the
  group directories.
- **No `scripts/bundle.mjs` edit.** esbuild follows imports from `src/index.ts`.
- **No `tsconfig` `references`, no root `paths`, no vitest aliases.** The build
  graph derives from `workspace:*`.
- **No per-package `vitest.config.ts`.** One root config serves every package.
- **No `eslint.config.js` or `prettier.config.js` entry.**
- **No change in `packages/core` or `apps/gateway`.** If you think you need one,
  the design is wrong: runtime CLI flags belong in the adapter.
- **No version bump.** The root `package.json` is the only place a version is
  written.
