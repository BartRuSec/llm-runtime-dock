# llm-runtime-dock

Local OpenAI/Anthropic-compatible LLM gateway that manages runtime processes and
switches models behind one endpoint.

`docs/` is the source of truth for behaviour — start at `docs/README.md`, which
indexes the specification and maps the `§N` numbers the code comments cite.
`README.md` is the user-facing manual. This file records only what is not
obvious from the code and is not already in `docs/`.

## Commands

`docs/02-architecture.md` has the full workflow. Two things that bite and are
not obvious there:

- Use `pnpm -r run <script>` explicitly — `pnpm -r clean` parses as a pnpm
  built-in, not as the workspace script.
- `main()` drops one leading `--` because pnpm forwards the separator into
  argv, where it would otherwise make `--help` a positional operand.
- `pnpm build` is two stages: `pnpm -r run build` (tsc per package, which is
  what tests and typecheck consume) and then `node scripts/bundle.mjs`. The
  order is not optional — see Packaging.

## Cross-platform rules

Windows is a supported target, so:

- **No shell utilities or globbing in scripts.** `clean` is `rimraf dist`, not
  `rm -rf`; `tsBuildInfoFile` is `${configDir}/dist/.tsbuildinfo` so one
  directory removal covers everything and no glob is needed. `pnpm dev` is
  `node scripts/dev.mjs`, because the build output has to reach stderr and
  `>&2` is not portable.
- **Both path separators count.** `expandHome` accepts `~/` and `~\\`;
  `doctor` detects a path with `isAbsolute` plus either separator, since
  `C:\\tools\\mtplx.exe` contains no forward slash.
- **Fixtures are launched through Node.** A shebang `.mjs` is not executable on
  Windows, so tests pass `fixtureCli(script)` — which sets `binary` to
  `process.execPath` and `binaryArgs` to the script. Adapters take
  `binaryArgs` for exactly this (also useful for `uvx mtplx`).
- **Signals barely exist on Windows.** Any `kill` terminates outright, so the
  graceful-then-force path in the executor is Unix-only; `serve` also listens
  for `SIGBREAK` there.
- Temp paths come from `os.tmpdir()`, never a `/tmp` literal.

## Build graph

There is no hand-maintained build graph: no TypeScript project `references`, no
root `paths`, no vitest aliases. It all derives from `workspace:*`, so adding a
package means: create it, add `workspace:*` where it is used, `pnpm install`.

Worth knowing: vitest transpiles with esbuild and does **not** typecheck, which
is why `pnpm typecheck` runs `tsc` over `tests/` too.

## Packaging

`npm i -g llm-runtime-dock` must land one file with no runtime dependencies, so
`scripts/bundle.mjs` runs esbuild over `src/index.ts` into `dist/index.js`.
`tsc` cannot do this — it emits file-per-file and never inlines `node_modules`,
which is the whole reason a bundler is here at all.

Five things are load-bearing here — four in that script, one in the sources it
reads:

- **`pnpm -r run build` has to run first.** esbuild resolves
  `@llm-runtime-dock/core` through its `exports` field, i.e. to that package's
  `dist/`. The bundle therefore contains the last tsc output, not the current
  sources. Do not paper over this with `conditions: ['source']`.
- **`mainFields: ['module', 'main']`.** esbuild defaults to `['main', 'module']`
  on `platform: 'node'`. `jsonc-parser` ships no `exports` map and points `main`
  at a UMD build whose inner `require('./impl/format')` calls survive bundling
  and then resolve against `dist/`, killing the bundle on load. `exports` beats
  `mainFields` outright, so this only reaches packages that lack one.
- **The `createRequire` banner is required, not defensive.** `@inquirer/prompts`
  pulls in a mixed CJS graph (`mute-stream`, `signal-exit`, `wrap-ansi`,
  `yoctocolors-cjs`) whose `require` calls reach the ESM output.
- **`__LRD_VERSION__` may appear only in `src/`.** esbuild's `define` is a
  textual substitution across the whole bundle, so a reference from any
  `packages/*` source would work here and then break that package's own `tsc`
  run, which never sees `src/globals.d.ts`.

- **zod is imported as `import * as z from 'zod'`, and the `en` locale is
  registered by hand.** Both halves, and both failures are invisible in review.
  `import { z } from 'zod'` — the obvious spelling, and what zod's own docs show
  — binds an object zod builds by re-exporting everything, which esbuild cannot
  see through: the bundle then carries all 53 locales, **+273 kB** for languages
  nothing selects. The namespace form tree-shakes them out, but it takes `en`
  with them, and every validation message silently degrades to a bare
  `Invalid input` with no expected/received detail. So
  `packages/core/src/config/schema.ts` also does `z.config(en())`, importing
  `zod/v4/locales/en.js` directly — 4 kB. Do not reach it through `z.locales.en`
  or `zod/v4/locales`: those are index re-exports and pull all 53 back. Every
  adapter inherits the setting, because zod's config is global to the module
  instance and each of them reaches that module through
  `@llm-runtime-dock/core`. **No test catches this.** vitest runs unbundled
  sources, where `en` loads regardless; only `dist/index.js` tree-shakes. The
  guard is the bundle smoke test — run `lrd` against a config with a type error
  and check the message still names the expected and received types.

The bundle is deliberately unminified, for readable stack traces from a global
install. `files` lists `dist/index.js` rather than `dist`, so the sourcemap
stays build-local: esbuild embeds `sourcesContent`, and shipping the whole
TypeScript source to npm is not what a CLI install is for.

`bin/lrd.mjs` stays a separate hand-written shim. Its Node version check cannot
move into the bundle, because an ESM module is parsed in full before its first
statement runs — an old Node would report a syntax error instead of the message.

`npm pack` leaves `devDependencies` in the published manifest, so the ten
`workspace:*` entries are visible there (`pnpm pack` rewrites them to `0.1.0`).
Harmless — npm never installs a dependency's devDependencies — but do not read
them as a claim that those packages exist on npm. They do not.

**The root `package.json` is the only place a version is written.** The ten
private packages carry a `version` too — that is what `pnpm pack` substitutes
for `workspace:*` — but `scripts/sync-version.mjs` generates them from the
root's, as the first stage of `pnpm build`. `pnpm typecheck` runs it with
`--check`, so drift fails rather than being silently repaired. Bump the root and
build; never edit the other ten. `scripts/bundle.mjs` throws on an empty root
version, because `define` is textual and would otherwise inline `undefined`.

## Dependency policy

`pnpm-workspace.yaml` sets `minimumReleaseAge: 20160` (14 days): nothing enters
the lockfile until it has survived two weeks in the wild, since a compromised or
broken release is usually caught within days and the fix lands after that. The
policy picks the version, not the wishlist — staying a major behind is the
correct outcome, not a failure. If a specific version ever genuinely has to
bypass it, reintroduce `minimumReleaseAgeExclude` deliberately with a comment
saying why; do not let one accumulate as a by-product of an install.

That last sentence is not hypothetical. Setting `minimumReleaseAge` implicitly
turns `minimumReleaseAgeStrict` on, and the workspace file now spells it out,
because flipping it to `false` is what an install failure tempts you to do and
it is the wrong fix: pnpm then stops failing and instead **rewrites
`pnpm-workspace.yaml` itself**, auto-collecting every too-new version into a
`minimumReleaseAgeExclude` list. That is where the sixteen orphaned `@inquirer/*`
pins in the first commit came from — the generated list was committed while the
`minimumReleaseAge` that produced it never was, leaving a list that excluded
from nothing. Reproducing it takes one install with `Strict: false` and yields
those exact sixteen lines. An install that hits the cooldown has to fail and be
resolved by a person; pnpm has no `maxAge` or upper-bound counterpart, so
`minimumReleaseAge` plus this flag is the whole policy surface.

Four consequences, each of which has already cost time:

- **pnpm verifies the _existing_ lockfile against the policy**, not just new
  resolutions. Changing the number therefore forces a re-resolution, and
  deleting `pnpm-lock.yaml` is not enough — pnpm restores it from
  `node_modules/.pnpm/lock.yaml`, so `node_modules` has to go too.
- **`@inquirer/prompts` stays on `^8.6.0`.** Its release cadence keeps the
  newest patch inside the cooldown, so bumping the caret to a `8.7.x` makes the
  range unsatisfiable and `pnpm install` fails outright with
  `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Widen the floor, never raise it to
  chase a release.
- **`pnpm-lock.yaml` is in `.prettierignore`.** pnpm owns that file's
  serialization; prettier rewrites 2197 lines of it into block style and the
  next install puts them back, so `format:check` would go red after every
  install.
- **TypeScript is capped below 6.1 by `typescript-eslint`**, not by anything in
  this repository. Its peer range is `typescript: >=4.8.4 <6.1.0`, and there is
  no `typescript-eslint@9` — so TypeScript 7 installs fine and then breaks
  `pnpm lint` with no upgrade path. `6.0.x` is the ceiling and is what we run.
  Revisit only once typescript-eslint ships TS 7 support; do not bump
  TypeScript alone and do not silence the peer warning.

`scripts/bundle.mjs` targets `node24`, tied to the `engines.node` floor — the
two move together or the bundle claims support it does not have.

## Layout

```text
src/index.ts             composition root — the repository root is the
                         published `llm-runtime-dock` package
bin/lrd.mjs              the `lrd` binary's ESM shim
packages/core            domain, scheduler, resident slot, config, proxy
packages/cli             lrd commands
packages/runtimes/*      mtplx, lm-studio, omlx, ollama, custom
packages/agents/*        opencode, claude, codex
apps/gateway             HTTP surface
```

The root is both the workspace and the one published package. Everything under
`packages/` and `apps/` is `private: true` and never reaches npm — it is folded
into a single bundled file at publish time (see Packaging).

Package names follow the spec (`@llm-runtime-dock/adapter-mtplx`) even though the
directories are grouped (`packages/runtimes/mtplx`).

`.claude/skills/` holds the two extension procedures for contributors —
`add-runtime-adapter` and `add-agent-integration` — and opencode loads them from
there too, which is why there is one copy rather than two. Neither has a
dispatcher under `.claude/commands/`: Claude Code already registers a skill as
`/<its name>`, so a same-named command file only registers the name a second
time. `.claude/commands/` holds `verify-extension.md` alone, because
`.opencode/commands/verify-extension.md` points at it as the single source of
that sequence. The files under `.opencode/commands/` are dispatchers with no
procedure text in them. `AGENTS.md` is a pointer file for tools that do not read
this one; it must never become a second copy of it.

## Code style

Two rules, enforced by ESLint (`func-style`, `no-restricted-syntax`), so a
violation fails `pnpm lint` rather than review:

- **Every function is an arrow function.** No `function` declarations, no
  function expressions, no object-literal method shorthand — a returned object
  uses arrow properties (`foo: () => {}`).
- **No classes.** Stateful objects are closure factories: an exported
  `interface X` plus a `createX()` that closes over its state and returns an
  object literal. Keeping the interface named `X` means every type position
  (`: DockService`, `: CliContext`) reads unchanged; only `new X(` call sites
  became `createX(`.

Two consequences worth knowing before editing:

- **`GatewayError`/`CliError` are interfaces, not classes.** Build them with
  `gatewayError(...)` / `cliError(...)` and test them with `isGatewayError` /
  `isCliError`, which read a `namespace` field rather than using `instanceof`.
  `new Error(...)` inside those factories is fine — the rule is about classes
  _this codebase_ declares.
- **A closure factory has no `this`.** A helper that another member calls must be
  a named `const` in the factory body, referenced directly. Watch for a local
  variable shadowing such a helper: `const port = port(runtime)` is a
  self-reference, which is why `MtplxAdapter` names its helper `portOf` and
  `CustomAdapter` names its `entryOf`.

## CLI output

Three rules, and the first is the one that breaks silently:

- **Pad first, colour second.** Every width in the CLI comes from
  `String.length`, which counts escape bytes. `packages/cli/src/output.ts`
  (`columns`, `keyValue`) encodes the ordering; use it rather than a fresh
  `padEnd`. `packages/cli/tests/theme.test.ts` asserts that stripping the
  escapes from a coloured run reproduces the plain run byte for byte.
- **Colour is resolved once**, in `createCliContext`, and reaches a command only
  as `context.theme`. No file under `commands/` imports `picocolors`: a
  module-scope colouriser would ignore the per-context switch and start leaking
  escape sequences into `--json`. `resolveColor` reads the injected `env`, not
  `process.env`, and returns `false` whenever the caller injected its own
  writers — which is why no test in this repository has to know colour exists.
- **ASCII only.** `doctor` prints `ok` / `warn` / `error` differentiated by
  colour, never `✔ ⚠ ✖`: a legacy Windows console mangles them.
- **One scheme per block.** A report is `label: value` rows through `keyValue`,
  with the label in `theme.label` and the value styled by what it is (`path`,
  `url`, `id`). Prose lines and bare labels mixed into such a block read as
  three different formats. `serve` loads its config with
  `loadConfig({ quiet: true })` for exactly this reason: the
  path is a row of its block, not the loose breadcrumb every other command gets.

Help styling is commander's own (`configureHelp({ styleTitle, … })`, 13+), which
measures with `displayWidth` and so aligns around the escapes. `getOutHasColors`
is overridden because commander's default reads `process.stdout.isTTY` directly,
which would bypass all of the above; it is consulted at write time, i.e. after
argv is parsed, which is what makes `lrd --help --no-color` work at all.

Core's logger takes an optional `LogPalette` of plain functions rather than a
colour dependency, so `packages/core` stays free of terminal concerns.

An adapter with public members beyond `RuntimeAdapter` exports a widened
interface for them (`MtplxAdapter`/`OmlxAdapter` add `serveArgs`, `LmStudioAdapter`
adds `loadArgs`), so tests keep compiling against the concrete adapter.

## Invariants that are easy to break

- **One resident model, globally — unless an entry sets `keep_resident`.** The
  flag is the only way out, and it is per entry, never a global mode. Two things
  are tracked: the _loaded set_ (one rotating occupant plus every kept entry) and
  the _serving token_ (exactly one, always). A kept entry is never released by a
  switch, and moving the token to or from one releases nothing either — both
  halves matter, since keeping a small model loaded while every trip to it still
  evicted the large one would be worse than not having the flag. The scheduler's
  FIFO pump is still the only thing that grants leases, so residency is not
  concurrency: the models share a GPU and take turns. Shutdown is the one place
  the flag stops applying — `scheduler.shutdown` releases the kept map as well
  as the occupant, because a kept entry's lifetime is the gateway's and nothing
  outside the process would free it.
- **Shutdown must never wait unboundedly, or nothing is released.** `server.close()`
  resolves only when every connection has ended and an SSE stream never ends on
  its own, so `RunningGateway.close` drops idle sockets at once, gives active
  ones `graceMs`, then calls `closeAllConnections()`; `service.shutdown()` runs
  in a `finally`. `serve` listens for SIGHUP as well as SIGINT/SIGTERM — closing
  a terminal sends it, and a child is not killed when its parent dies — and uses
  `process.on`, so a second press exits explicitly instead of forcing a SIGKILL
  that orphans every loaded model.
- **A kept entry on a `stop_server` runtime must own that runtime alone.** MTPLX
  and custom serve one model per server, so starting a sibling entry means
  `mtplx stop --port …` — the very thing the flag forbids. `checkKeptResidency`
  in `config/load.ts` rejects it at load time, checking the `runtimes:` key _and_
  the `host:port`, because two runtime keys aimed at one port are one server.
- **`keepLoaded` is what stops an adapter undoing the flag.** `enforceSingleResident`
  unloads everything that is not its target, which is exactly a kept model on the
  same server. `acquire` and `verifyIdentity` both take a `ResidencyContext`, and
  core filters the list by `runtimeId` and spells it with each entry's own
  `servedModelId` — LM Studio answers to its `--identifier`, oMLX to a backend
  model name, and Ollama to a tag-qualified model name. Ollama normalizes an
  omitted `:latest` tag, so a foreign id would match nothing or the wrong thing.
- **`discovery: false` must be filtered on the bare path, never in `declaredRuntimes`.**
  Two silent bugs follow from getting this wrong, and neither is visible in the
  diff. `selectSubjects` builds `covered` from the declared runtimes and then
  probes every _uncovered_ adapter at its `defaultProbeTarget`, so an excluded
  runtime dropped from that list resurrects its adapter at an endpoint nobody
  declared, written by `--save` under the adapter's id. And the named-target
  lookup reads the same list, so filtering there makes `lrd probe <that-runtime>`
  — the one documented override — miss and fall through to a synthetic subject
  that loses the entry's `host`/`port`/`apiKeyEnv`. Subjects carry
  `discoverable`; only the bare return and the adapter fan-out filter on it, and
  the fan-out returns empty rather than falling through.
- **In discovery, existing ownership is settled before anything else.** A
  catalogue belongs to the installation, not the server — `mtplx models` does not
  know which port asked — so two runtimes of one adapter always rediscover each
  other's models, which `keep_resident` makes the normal shape. `saveDiscovery`
  therefore runs two passes: collect every candidate, then decide, checking the
  configured owner _first_. Doing it the other way round — the in-run "claimed
  by someone else" test first — reports a model as colliding with itself. A retained id must still be `claimed`, or the staleness pass reads
  it as unfound and offers to delete it.
- **`disabled` is enforced at one gate and by omission everywhere else.**
  `resolveModel` is the only place a disabled entry is refused, which is what
  keeps it out of the scheduler — `acquire`/`switchTo` are reachable only
  through it. Nothing else guards; the two lists that _publish_ the catalogue
  (`listLogicalModels` and the `models` loop in `buildApplyPlan`) simply leave
  it out, and `servedModelIds` is the one spelling of "which ids those are".
  Anything new that enumerates `config.models` for a user-facing purpose has to
  decide whether it filters: `doctor` and `lrd models` deliberately do not, so
  the entry stays visible to the person who wrote it.
- **Core must not import a concrete adapter.** Only the composition root
  (`src/index.ts`) does. Runtime CLI flags belong in adapters, agent formats in
  agent packages.
- **No request-derived command execution.** Argv arrays only; `shell: true` is
  opt-in configuration. A request selects _which_ entry runs, never _what_ runs.
- **Never `lms server stop` during a switch.** The LM Studio server is shared;
  `LmStudioAdapter.stop()` throws on purpose. The scheduler only calls
  `acquire`/`release`, never `stop`.
- **A `stop_server` runtime is stopped even when attached, not spawned**, and
  that is logged as "releasing foreign …".
- **One `DEFAULT_PORT` per adapter package.** It is read both by
  `defaultProbeTarget` and by the `port ?? default` fallback, and a test in each
  package pins the two together. Splitting them gives a probe that finds a server
  the gateway then fails to reach. `mtplx` and `omlx` both default to 8000, while
  Ollama defaults to 11434;
  `probe()` asks a server whether it is its own before claiming it, and reports
  `foreign_server` when it is not.
- **`probe --start` is per adapter, and MTPLX opts out on purpose.** LM Studio
  and oMLX report nothing when their server is down, so starting it is what makes
  the probe useful; Ollama also requires a running server but has no daemon-style
  start command for probe; MTPLX reports its whole installed catalogue either way, so
  starting it would load one model and then "discover" that model. `lms server
start` reads its port back, `omlx start` cannot — it takes none — so oMLX
  checks the endpoint it was given instead of trusting it.
- **`@inquirer/prompts` is imported in exactly one file**, `packages/cli/src/prompt.ts`.
  An adapter declares its probe questions as data (`probeQuestions`) and never
  learns how they are asked — the same rule that keeps `packages/core` free of
  terminal concerns.
- **`runtimes:` owns the endpoint, `models:` owns the model.** `RuntimeInstance`
  still carries `adapterId`/`host`/`port` flattened, so the scheduler, proxy and
  gateway never see the split; `rawRuntime` is where the custom adapter's
  `process`/`health`/`endpoint` blocks live now. Both `raw` and `rawRuntime` are
  `Record<string, unknown>`, so reading the wrong one returns `undefined` rather
  than failing to compile.
- **Only the `model` field of a request body is rewritten** (logical id →
  served id). No inference defaults are injected. That is a guarantee about
  _fields_, not bytes: `rewriteModelField` parses and re-serializes, so
  formatting, duplicate keys and number spelling (`1.50` → `1.5`) do not
  survive. Nothing reads or writes `tools`, `tool_choice`, `messages` or
  `stream` anywhere on the request path.
- **Response headers are a denylist, not an allowlist.** Hop-by-hop plus
  `content-length`/`content-encoding` are dropped and everything else passes;
  an allowlist silently swallowed `retry-after`. The upstream's `x-request-id`
  survives as `x-upstream-request-id`, because the gateway stamps its own.
- **`lrd serve --debug` is the instrument, and it is a tee.** `RequestTap` may
  never alter a byte, and it captures both hops — assuming the client-side relay
  is 1:1 would defeat the point of measuring it.
- **`/status` and `/switch` are loopback-only** and answer a plain 403 refusal,
  not a gateway error code.

## Error namespaces

`GatewayError` codes become HTTP responses. `CliError` codes exit non-zero and
must never reach the response mapper — `GATEWAY_NOT_RUNNING` cannot be an HTTP
answer by definition.

## Testing

Tests live in the package they cover; `tests/` at the root holds only end-to-end
suites — those that span packages or spawn a real runtime process.

- Package tests import their own code from `../src` (no build needed) and run
  via `pnpm -r run test`, or one at a time with `pnpm --filter <pkg> run test`.
- Root e2e imports workspace packages by name, so it needs `pnpm build` first
  and exercises the real `exports` entry points.
- One `vitest.config.ts` at the root serves every project: vitest resolves
  `include: ['tests/**']` against whichever directory it runs in, and packages
  inherit the file. Do not add per-package vitest configs.
- **Core's tests must not import an adapter or agent** — that is the §6 rule
  pnpm enforces. Use `packages/core/tests/helpers/stubs.ts`, which provides a
  configurable `RuntimeAdapter` and `AgentIntegration`.

`tests/fixtures/fake-runtime.mjs` is one configurable fake backend (503-loading
window, model mismatch, crash, stop delay, multi-model load/unload, LRU
auto-load, pinned models, credential required, SSE chunk count/delay/padding),
driven entirely by env vars. `FAKE_STREAM_PAD_BYTES` exists so a test can fill a
client's socket buffer: without enough bytes in flight `res.write` never returns
false and the gateway's backpressure path is never reached.
`fake-mtplx.mjs`, `fake-lms.mjs`, `fake-omlx.mjs` and `fake-ollama.mjs` wrap it as the runtime CLIs.
Adapters take a `binary` option so tests point them at the fakes. Fixtures are
used only by the root e2e suites.

A `ConfigLocation` with `found: false` resolves the write target to the user's
**real** `~/.config/llm-runtime-dock/config.yaml`. Tests must always construct
locations with `found: true` inside a temp directory.
