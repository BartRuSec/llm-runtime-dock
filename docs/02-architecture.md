# Architecture

The workspace layout, the dependency direction the core depends on, and how a
new adapter or agent is registered.

---

## Monorepo

Use a pnpm workspace.

Recommended structure:

```text
llm-runtime-dock/
├── src/
│   └── index.ts            composition root
├── bin/
│   └── lrd.mjs             the `lrd` binary
├── apps/
│   └── gateway/
├── packages/
│   ├── core/
│   ├── cli/
│   ├── adapter-mtplx/
│   ├── adapter-lm-studio/
│   ├── adapter-omlx/
│   ├── adapter-ollama/
│   ├── adapter-custom/
│   ├── agent-opencode/
│   ├── agent-claude/
│   └── agent-codex/
├── examples/
│   └── config.yaml
├── scripts/
├── tests/
├── docs/
├── package.json            the published manifest, and the workspace root
├── pnpm-workspace.yaml
├── tsconfig.json
├── eslint.config.js
├── prettier.config.js
├── LICENSE
└── README.md
```

The repository root is the published package. The composition root lives at
`src/index.ts` rather than in a package of its own: it is forty lines that only
wire concrete adapters and agents together, and putting it at the root means the
manual in `README.md` and `LICENSE` reach the npm page, which a nested package
directory would not.

If a separate package adds no real public boundary, it may remain an internal module instead. Do not create packages merely for theoretical modularity.

Target package names:

```text
@llm-runtime-dock/core
@llm-runtime-dock/cli
@llm-runtime-dock/adapter-mtplx
@llm-runtime-dock/adapter-lm-studio
@llm-runtime-dock/adapter-omlx
@llm-runtime-dock/adapter-ollama
@llm-runtime-dock/adapter-custom
@llm-runtime-dock/agent-opencode
@llm-runtime-dock/agent-claude
@llm-runtime-dock/agent-codex
```

Those names organise the sources. Every one of them is `private: true` and none
is published — they exist for the development flow, not for npm.

The one published package is `llm-runtime-dock` and is meant to be installed
globally:

```bash
npm i -g llm-runtime-dock
```

It exposes one binary, deliberately shorter than the package name:

```text
lrd
```

A global install shapes a few things: the published package must carry built output rather than sources, the `bin` entry needs a proper ESM shim with a shebang, and Node >= 24 must be enforced through `engines` so the failure is a clear message instead of a syntax error.

### One file, no runtime dependencies

The published tarball holds `dist/index.js`, `bin/lrd.mjs`, the manifest,
`README.md` and `LICENSE` — nothing else, and no `dependencies` at all. That is
not what `tsc` produces: it emits file-per-file and never inlines
`node_modules`, so a tsc-only build would have to declare all nine workspace
packages plus Commander, YAML, Zod, `@inquirer/prompts`, `smol-toml` and
`jsonc-parser` as real dependencies and publish the whole graph to npm.

So the build has two stages, and the order matters:

```bash
pnpm -r run build      # tsc per package — what tests and typecheck consume
node scripts/bundle.mjs # esbuild — collapses the graph into one file
```

`pnpm build` runs both. esbuild resolves each workspace package through its
`exports` field, i.e. against that package's `dist/`, so the bundle reflects the
last `tsc` run rather than the current sources. That is deliberate — the bundle
exercises the real published entry points — but it means the stages cannot be
reordered.

esbuild is the right size for this: it is what Vite uses underneath, without a
dev server or a plugin layer, and it stays within "avoid unnecessary
dependencies" better than a wrapper such as tsup would.

`pnpm dev` runs the bundle rather than the tsc output, which is how the shipped
artifact gets exercised daily instead of first at publish time.

---

## Technology

- Node.js >= 24
- TypeScript
- ESM
- pnpm
- strict TypeScript
- native `fetch`
- AbortController for request/process cancellation
- a small HTTP framework is acceptable, but do not introduce a heavy framework without a reason
- Commander for CLI parsing (subcommands, options, help)
- `@inquirer/prompts` for the two places the CLI asks a question: which model a role should use ([§23](08-agents.md#agent-integrations)), and whether a save may delete a model the probe did not find ([§22](07-discovery.md#runtime-discovery))
- YAML configuration
- JSON Schema or equivalent runtime validation for config
- Vitest or equivalent test runner

Avoid unnecessary dependencies.

---

## Core Architecture

The core must not import any concrete runtime adapter.

Dependency direction:

```text
CLI ───────────────┐
Gateway ───────────┼──> Core <── Adapter implementations
                   │
Config ────────────┘
```

Adapters depend on core interfaces.

Core must contain:

- configuration/domain types
- model resolution
- runtime registry
- the resident slot
- lifecycle orchestration
- runtime state machine
- scheduler/queue
- health/readiness handling
- model identity verification
- request routing
- errors
- logging interfaces

Core must NOT contain:

- MTPLX-specific logic
- LM Studio-specific logic
- oMLX-specific logic
- Ollama-specific logic
- coding-agent configuration formats
- mapping of configuration options onto a specific runtime's CLI flags
- inference implementation
- GUI automation
- model downloading
- quantization
- GPU memory management
- database
- web UI

---

## Plugin System

Registration is explicit. There is no npm package discovery, and none is needed:
the composition root imports the adapters it ships with and hands them to a registry.

Conceptually:

```ts
registerRuntimeAdapter(adapter);
```

The core must work without importing concrete adapters.

Future versions may support npm package discovery. Dynamic discovery is deliberately absent here.

A plugin should provide:

- adapter ID
- config schema, including its curated launch-option schema and its reserved-argument list
- model release mechanism (`unload_model` or `stop_server`)
- default probe target ([§22](07-discovery.md#runtime-discovery))
- runtime adapter, including its `probe()` implementation
- optional CLI integration metadata
- capability declaration

Adapters must be independent of each other.

---

## Developer Experience

```bash
pnpm install
pnpm build        # pnpm -r run build, in dependency order, then the bundle
pnpm bundle       # the esbuild stage alone, over an existing package build
pnpm test         # builds, then every package's tests, then the e2e suite
pnpm test:unit    # package tests only
pnpm test:e2e     # root end-to-end suite only
pnpm lint
pnpm typecheck    # every package, plus every tests/ directory
pnpm clean
```

Every script runs on Windows as well as macOS and Linux: `clean` uses `rimraf`
rather than `rm -rf`, `pnpm dev` is a Node launcher rather than a shell redirect,
and nothing relies on shell globbing or a POSIX-only utility.

### Build graph

Each package owns its own `build`/`typecheck`/`clean` scripts, and the root
delegates with `pnpm -r run`. Build order comes from the `workspace:*`
dependencies, so there is no separate graph to keep in sync — and independent
packages build in parallel. Work on one package with a filter:

```bash
pnpm --filter @llm-runtime-dock/core run build      # just core
pnpm --filter '...@llm-runtime-dock/core' run build # core and everything downstream
```

`pnpm -r` covers the workspace packages and never the root, so the root's own
`build` — which calls `pnpm -r run build` — cannot recurse into itself. The
publishing stage is not part of that graph: `node scripts/bundle.mjs` reads the
packages' `dist/` output and is therefore always last
([Packaging](#one-file-no-runtime-dependencies)).

The rule that core must not import an adapter ([§6](#core-architecture)) is
enforced by pnpm's isolated `node_modules`, not by tsconfig:
`packages/core/node_modules/@llm-runtime-dock` does not exist. Adding a package
therefore means creating it, adding `workspace:*` where it is used, and running
`pnpm install`. Nothing else to update.

### Working on the CLI

`pnpm dev` runs `lrd` from the current sources, rebuilding incrementally first so
a stale binary is never run — including the esbuild stage, so day-to-day work
exercises the artifact that ships rather than one only publishing would produce.
Build output goes to stderr, so stdout stays pipeable:

```bash
pnpm dev -- probe mtplx --save --dry-run
pnpm dev -- doctor --config examples/config.yaml
pnpm dev -- probe mtplx > snippet.yaml
```

### Where tests live

```text
packages/core/tests/           config, scheduler, resolution, discovery, apply
packages/runtimes/*/tests/     that runtime's options, argv and reserved flags
packages/agents/*/tests/       that agent's config format
packages/cli/tests/            command-line parsing
apps/gateway/tests/            error mapping, loopback rules
tests/e2e/                     everything that spans packages or spawns a runtime
```

Run one package's tests with `pnpm --filter @llm-runtime-dock/core run test`.
Package tests import their own code from `../src` and need no built output; the
end-to-end suites import workspace packages by name, so they exercise the real
published entry points against `dist`. See [§31](11-testing.md#testing) for what
those suites are required to cover.

### Code style

Strict TypeScript; avoid `any`; prefer discriminated unions and explicit domain
types. Keep adapters thin, keep orchestration in core, and keep business logic
out of HTTP route handlers.

Every function is an arrow function and there are no classes — stateful objects
are closure factories returning an object literal, paired with an exported
`interface` of the same name. Both rules are enforced by ESLint, so a violation
fails `pnpm lint` rather than review.
