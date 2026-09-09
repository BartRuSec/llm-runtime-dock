---
name: add-runtime-adapter
description: Add support for another inference server or backend to llm-runtime-dock - vLLM, Ollama, llama.cpp, an MLX server, a hosted proxy - either as a first-class adapter package under packages/runtimes, or by deciding the declarative custom adapter is enough and no TypeScript is needed. Use when someone wants the gateway to drive a runtime it does not ship with, asks how RuntimeAdapter works, or asks what a new backend has to implement.
---

# Adding a runtime adapter

## Step 0 - decide whether you need a package at all

Most runtimes do not. A backend that starts with a command, answers a health URL
and speaks the OpenAI surface is a **config entry**, not code: that is the
`custom` adapter. Read `legacy-runtime` in `examples/config.yaml` and
[§11](../../../docs/04-adapters.md#custom-adapter) first.

Write a package only when at least one of these is true:

- launch options have to be **mapped** onto the runtime's own CLI flags, with
  validation and a curated set of names;
- readiness is more than "the health URL answers" - a load call, a status poll, a
  count of resident models;
- there is a **CLI to drive** (`lms load`, `mtplx serve`), not just a process to
  spawn;
- the runtime needs its own probe for `lrd probe` - its own endpoint, its own
  response shape, or its own way of proving a server on that port is actually
  it (two runtimes may share a default port).

If none of those hold, stop here and write YAML. Saying so is a good answer.

## Read before writing

- [§7 Runtime Adapter Interface](../../../docs/04-adapters.md#runtime-adapter-interface) - the contract.
- [§21 Plugin System](../../../docs/02-architecture.md#plugin-system) - what a plugin owns.
- `reference/contract.md` here - every member, one line each.
- `reference/checklist.md` here - what to touch, and what **not** to.

## Step 1 - pick the package you copy from

There is no template directory. You copy a live package, because those are built,
typechecked, linted and tested on every run. Pick by the shape of the backend:

| the backend is                                | copy        | its `modelRelease` |
| --------------------------------------------- | ----------- | ------------------ |
| declarative, no TypeScript needed             | `custom`    | `stop_server`      |
| a server you spawn, with HTTP load/unload     | `omlx`      | `unload_model`     |
| a shared server you must never stop           | `lm-studio` | `unload_model`     |
| driven by its own CLI, freed by restarting it | `mtplx`     | `stop_server`      |

`packages/runtimes/omlx` is the default answer and the smallest complete example:
four files.

## Step 2 - create the package

`packages/runtimes/<name>/` with exactly these files:

- `package.json` - copy the reference one, change `name` to
  `@llm-runtime-dock/adapter-<name>`. Keep `private: true`, the `exports` map,
  and **keep `version` equal to the root `package.json` version** (see Traps).
- `tsconfig.json` - copy it byte for byte. It is identical in every package.
- `src/options.ts` - the zod schema, `OPTION_SPECS`, `RESERVED_ARGS`,
  `SERVER_SCOPED_OPTION_KEYS`, and the arg renderer.
- `src/adapter.ts` - `export interface XAdapter extends RuntimeAdapter` (only if
  you add public members beyond the contract) plus
  `export const createXAdapter = (options: XAdapterOptions = {}): XAdapter => {...}`.
- `src/index.ts` - the barrel: `export * from './adapter.js'; export * from './options.js';`
- `tests/options.test.ts` - see Step 5.

Factory options follow the house shape:
`{ binary?, binaryArgs?, executor?, logger?, startupTimeoutMs?, loadTimeoutMs? }`,
with `binary` falling back to `process.env.LRD_<NAME>_BIN`.

## Step 3 - register it

Two edits outside the package, and no others:

1. `src/index.ts` at the repository root - the composition root, the only file
   allowed to import a concrete adapter. Add the import and one entry to
   `defaultAdapters`.
2. Root `package.json` - add `"@llm-runtime-dock/adapter-<name>": "workspace:*"`
   to **`devDependencies`** (that is where all workspace packages live; the
   published package declares no runtime dependencies). Then `pnpm install`.

There is no build graph to update. See the NOT-required list in
`reference/checklist.md` before you go looking for one.

## Step 4 - update the documentation

`docs/` is the source of truth for behaviour, and several files enumerate the
adapters. Find every one of them by grepping for an existing id rather than
working from a list that can go stale:

```
grep -rn "omlx" README.md CLAUDE.md docs examples
```

Update every hit that is an enumeration (release-mechanism tables, probe sample
output, the `adapter` field's allowed values, the layout tree), and add a
`## <Name> Adapter` section to `docs/04-adapters.md`.

## Step 5 - test

Copy `packages/runtimes/omlx/tests/options.test.ts`. It covers the contract end
to end in four assertions worth keeping:

- the renderer produces the exact documented flags;
- an undocumented option value throws, asserted as
  `expect.objectContaining({ namespace: 'cli' })`;
- `adapter.serverScopedOptionKeys` matches the exported constant;
- a real YAML string round-trips through `parseConfig`, so core's reserved-arg
  and shared-endpoint checks actually run against your adapter.

`packages/core/tests/helpers/stubs.ts` (`createStubAdapter`) is the
minimum-conformance checklist - **read it, do not import it**; core exports only
`.`, so it is not resolvable from your package.

If your adapter spawns a process, add an end-to-end test: a
`tests/fixtures/fake-<name>.mjs` wrapping `fake-runtime.mjs`, a `FAKE_<NAME>`
constant in `tests/helpers/env.ts`, and a suite modelled on
`tests/e2e/mtplx-launch.test.ts`. Point the adapter at it with
`fixtureCli(script)`, which sets `binary` to `process.execPath` - a shebang
script is not executable on Windows.

## Step 6 - verify

Run the gauntlet in `.claude/commands/verify-extension.md`, cheapest first.
The short form:

```
pnpm install && pnpm -r run build && pnpm --filter @llm-runtime-dock/adapter-<name> run test
pnpm typecheck && pnpm lint && pnpm test
npx prettier --check packages/runtimes/<name> docs README.md
```

Then the parity check: your new id should appear everywhere the reference id
does.

```
grep -rn "omlx" --include=*.ts packages src
```

## Traps

Each of these fails a build in a way that does not name the real cause.

- **`version` is generated.** A new package's `version` must equal the root's.
  `pnpm typecheck` runs `scripts/sync-version.mjs --check` **before** any
  TypeScript, so a mismatch fails first with "packages disagree with the root
  version". Fix: `pnpm run version:sync`. Never edit a package version by hand;
  the root `package.json` is the only place a version is written.
- **`pnpm -r run build` must precede the bundle.** esbuild resolves
  `@llm-runtime-dock/*` through each package's `exports`, i.e. to its `dist/`.
- **Core must never import your package.** Only the composition root does. That
  rule is enforced by pnpm's isolated `node_modules`, so a violation shows up as
  an unresolvable import, not a lint error.

## Style rules that fail `pnpm lint`

ESLint enforces these (`func-style`, `no-restricted-syntax`), so they are not
review comments - they are build failures.

- **Every function is an arrow function.** No `function` declarations, no
  function expressions, no object-literal method shorthand: a returned object
  uses arrow properties.
- **No classes.** A stateful object is a closure factory: an exported
  `interface X` plus a `createX()` that closes over its state and returns an
  object literal.
- **No `this`.** A helper another member calls is a named `const` in the factory
  body. Watch for a local shadowing it - `MtplxAdapter` names its helper `portOf`
  for exactly this reason.
- **Errors are interfaces, not classes.** Build them with `gatewayError(...)` /
  `cliError(...)`; test with `isGatewayError` / `isCliError`.
- **Windows is a supported target.** `os.tmpdir()`, never a `/tmp` literal; accept
  both path separators; no shell utilities or globbing in scripts; `binaryArgs`
  so a script-based command stays launchable.
- **ASCII only in CLI output.** No `checkmark`/`warning` glyphs - a legacy Windows
  console mangles them.

## Invariants you can break silently

- **One resident model, globally.** Not a tunable. If your runtime can hold more
  than one model, the adapter must confirm residency explicitly - see
  `enforceSingleResident` in the oMLX adapter.
- **The scheduler only calls `acquire` and `release`**, never `stop`. There is
  deliberately no `restart`.
- **No request-derived command execution.** Argv arrays only. A request selects
  _which_ entry runs, never _what_ runs.
