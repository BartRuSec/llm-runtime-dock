# Contributing

Contributions are welcome. This file is a pointer — the procedures themselves live
in the repository and are the source of truth.

## Orientation

- **[`AGENTS.md`](AGENTS.md)** is the shortest path in: it names the three places
  that hold the truth and what each one is for.
- **[`docs/README.md`](docs/README.md)** is the specification and the source of
  truth for behaviour. It indexes every section and maps the `§N` numbers the code
  comments cite.
- **[`CLAUDE.md`](CLAUDE.md)** holds the conventions that are not obvious from the
  code — the arrow-function and no-class rules ESLint enforces, the cross-platform
  rules, the packaging, dependency and version-generation rules, and the
  invariants that are easy to break. **Read it before editing any TypeScript.**
- **[`README.md`](README.md)** is the user-facing manual.

## Extending the project

The two most common contributions are written down as step-by-step procedures,
loadable as skills from either Claude Code or opencode:

- [`.claude/skills/add-runtime-adapter/SKILL.md`](.claude/skills/add-runtime-adapter/SKILL.md)
  — support another inference backend, or decide the declarative `custom` adapter
  is enough and no TypeScript is needed.
- [`.claude/skills/add-agent-integration/SKILL.md`](.claude/skills/add-agent-integration/SKILL.md)
  — make `lrd apply` write the gateway into another coding agent's configuration.

## Verifying a change

```bash
pnpm install && pnpm -r run build && pnpm typecheck && pnpm lint && pnpm test
```

`pnpm build` is two stages and the order is not optional — see the Packaging
section of `CLAUDE.md`. The longer form of the gauntlet, with what each failure
actually means, is in
[`.claude/commands/verify-extension.md`](.claude/commands/verify-extension.md).

Formatting is prettier: `pnpm format` writes, `pnpm format:check` verifies.

Node 24 or newer, and pnpm via corepack. Dependencies are held to a 14-day
`minimumReleaseAge`, so `pnpm install` will refuse a package published in the
last fortnight — that is the policy working, not a broken lockfile. See the
Dependency policy section of `CLAUDE.md` before reaching for an exception.

## A few house rules

- **Every function is an arrow function, and there are no classes.** ESLint fails
  the build on either, so this is not a review comment you will get twice.
- **Tests live in the package they cover.** `tests/` at the repository root holds
  only end-to-end suites — those that span packages or spawn a real runtime
  process.
- **The root `package.json` is the only place a version is written.** The other
  workspace packages get theirs from `scripts/sync-version.mjs`; never edit them.
