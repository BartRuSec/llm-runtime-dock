---
name: add-agent-integration
description: Add support for another coding agent or editor to llm-runtime-dock (packages/agents/*) so that lrd apply can write the gateway into its own configuration file - Cursor, Zed, Aider, Continue, Windsurf and the like. Use when someone wants lrd apply to configure a tool it does not ship with, asks how AgentIntegration works, or asks what a new coding-agent target has to implement.
---

# Adding an agent integration

## Read this first: agents are not plug-and-play

A runtime adapter is a pure plugin - core knows nothing about it. **An agent is
not.** Five places outside your package hard-code the set of known agent ids, and
the sharpest of them fails silently from the user's point of view: `agentsSchema`
is `.strict()`, so until your agent has a key there, a user who writes your
agent's block into `agents:` gets a config **validation error**, while your
package looks perfectly correct.

The package alone will not work. `reference/hardcoded-sites.md` lists all five,
located by symbol name.

## Read before writing

- [§23 Agent Integrations](../../../docs/08-agents.md#agent-integrations) - the
  contract and the per-agent config formats.
- `reference/hardcoded-sites.md` here - the five shared-code edits.
- `reference/checklist.md` here - what to touch, and what **not** to.

## The contract

`AgentIntegration`, in `packages/core/src/agent.ts`:

```ts
interface AgentIntegration {
  readonly id: string;
  readonly displayName: string;
  readonly surface: 'openai' | 'anthropic';
  readonly supportsSecretReference: boolean;
  readonly roles: readonly string[];
  readonly requiresRoleMapping: boolean;
  configPath(): string;
  isInstalled(): Promise<boolean>;
  render(plan: ApplyPlan): Promise<RenderedConfig>;
}
```

`render` is deliberately **pure**: `--dry-run` and the real write share one code
path. It takes an `ApplyPlan` (`gatewayBaseUrl`, `models`, `roles`, `settings`,
`existing`, `configPath`) and returns a `RenderedConfig`
(`{ path, content, warnings }`). The write, the backup and the idempotency check
are generic and already live in `packages/core/src/agent-apply.ts` - you do not
implement them.

`supportsSecretReference: false` means `apply` refuses rather than inlining a
secret. **Never write a secret**: emit the tool's own environment-variable
reference syntax.

## Step 1 - pick the package you copy from

There is no template directory; you copy a live package. Four files each, no
`options.ts`:

| the target's config is                               | copy       |
| ---------------------------------------------------- | ---------- |
| JSON or JSONC, edited in place to keep comments      | `opencode` |
| TOML                                                 | `codex`    |
| driven entirely by roles rather than one model field | `claude`   |

## Step 2 - create the package

`packages/agents/<name>/` with `package.json` (name
`@llm-runtime-dock/agent-<name>`, `version` equal to the root's),
`tsconfig.json` copied byte for byte, `src/index.ts` (the whole integration - one
factory returning an object literal), and `tests/render.test.ts`.

Everything the agent knows lives in `render`: parse what exists, merge,
stringify. Preserve keys you do not own, and push a **warning** rather than
silently dropping something you cannot round-trip - the codex integration warns
about TOML comments for exactly this reason.

## Step 3 - register it

- `src/index.ts` at the repository root - one import, one entry in
  `defaultAgents`. The composition root is the only file allowed to import a
  concrete integration.
- Root `package.json` - `"@llm-runtime-dock/agent-<name>": "workspace:*"` in
  **`devDependencies`**, then `pnpm install`.

## Step 4 - the five hard-coded sites

Work through `reference/hardcoded-sites.md`. Skipping any of them produces a
package that builds, passes its own tests, and does not work.

## Step 5 - documentation

Find the enumerations by grepping for an existing id, not from a list that can go
stale:

```
grep -rn "opencode" README.md CLAUDE.md docs examples
```

Update `docs/08-agents.md` (the `requiresRoleMapping` table and the per-agent
config shapes), `examples/config.yaml`, and the coding-agents section of
`README.md`.

## Step 6 - test

Copy `packages/agents/opencode/tests/render.test.ts`. It builds an `ApplyPlan`
literal by hand and asserts three things worth keeping:

- merging preserves keys the integration does not own;
- the rendered config carries an env-var reference, never a secret value;
- re-rendering the output is byte-identical - that is the idempotency guarantee
  `apply` depends on.

## Step 7 - verify

```
pnpm install && pnpm -r run build && pnpm --filter @llm-runtime-dock/agent-<name> run test
pnpm typecheck && pnpm lint && pnpm test
npx prettier --check packages/agents/<name> docs README.md
pnpm dev -- apply --help
```

The full gauntlet, with what each failure actually means, is in
`.claude/commands/verify-extension.md`.

Then the parity check - your id should appear everywhere the reference id does:

```
grep -rn "opencode" --include=*.ts packages src
```

Keep the grep path-scoped: `.claude/` and `.opencode/` mention `opencode` too,
and they are this repo's own tooling files, not code.

## Traps

- **`version` is generated.** A new package's `version` must equal the root's.
  `pnpm typecheck` runs `scripts/sync-version.mjs --check` **before** any
  TypeScript, so a mismatch fails first, with a message about package versions
  rather than about your code. Fix: `pnpm run version:sync`.
- **Writing into files someone else owns.** Write back to the file that exists
  (`.jsonc` stays `.jsonc`), merge rather than replace, back up first, and stay
  idempotent.
- **Core knows nothing about provider blocks or TOML tables**, exactly as it
  knows nothing about runtime CLI flags. Format knowledge belongs in your
  package.

## Style rules that fail `pnpm lint`

ESLint enforces these (`func-style`, `no-restricted-syntax`); they are build
failures, not review comments.

- **Every function is an arrow function.** No `function` declarations, no
  function expressions, no object-literal method shorthand.
- **No classes.** A stateful object is a closure factory: an exported
  `interface X` plus a `createX()` returning an object literal.
- **No `this`.** A helper another member calls is a named `const` in the factory
  body.
- **Errors are interfaces, not classes.** Build them with `cliError(...)` /
  `gatewayError(...)`; test with `isCliError` / `isGatewayError`.
- **Windows is a supported target.** `os.tmpdir()`, never a `/tmp` literal;
  accept both path separators; no shell utilities or globbing.
- **ASCII only in CLI output.**
