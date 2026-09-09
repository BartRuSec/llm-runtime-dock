# The five hard-coded agent sites

Unlike a runtime adapter, an agent id is named explicitly in core and in the CLI.
Locate each site by **symbol name**, not by line number.

```
grep -rn "opencode" --include=*.ts packages/core/src packages/cli/src
```

Everything that grep reports outside a comment is a site you must mirror.

---

## 1. `agentsSchema` - `packages/core/src/config/schema.ts`

The sharpest one. The schema is `.strict()`, so an `agents:` block naming an
unknown agent is a **config validation error** - your package looks fine and the
user cannot use it:

```
error [CONFIG_INVALID] config.yaml: agents: Unrecognized key(s) in object: 'cursor'
```

```ts
export const agentsSchema = z
  .object({
    claude: z.object({ opus: z.string().optional() /* ... */ }).strict().optional(),
    codex: z
      .object({ model: z.string(), reasoning_effort: z.string().optional() })
      .strict()
      .optional(),
    opencode: z.object({ default: z.string() }).strict().optional(),
    // add your agent's block here, .strict().optional()
  })
  .strict();
```

Shape it after your `roles`: one optional key per role, or a single required
`model` if the agent has exactly one.

## 2. `configuredRoles` - `packages/core/src/agent.ts`

An `if` chain on `agentId` that turns the config block into
`Record<role, modelId>`. **A missing branch silently yields no roles** - `apply`
then writes a provider block with no role mapping and nobody sees an error.

```ts
if (agentId === '<name>') return agents.<name> ? { default: agents.<name>.default } : {};
```

## 3. `configuredSettings` - `packages/core/src/agent.ts`

Non-role scalars that reach `ApplyPlan.settings`. Today only
`codex.reasoning_effort` uses it. Add a branch only if your agent has such a
setting.

## 4. Role-target validation - `packages/core/src/config/load.ts`

A sequence of `check(agent, role, value)` calls that reject a role pointing at a
model id the config does not define. Without a line here, a typo in the user's
`agents:` block survives load and fails later, further from its cause.

```ts
check('<name>', 'default', agents.<name>?.default);
```

## 5. `overridesFor` and `selectAgents` - `packages/cli/src/commands/apply.ts`

- `overridesFor` maps the CLI flags (`--opus`, `--sonnet`, `--haiku`, `--model`)
  onto role names for the current agent. Add an `else if (agent.id === '<name>')`
  branch, reusing `--model` unless the agent genuinely needs its own flag.
- `selectAgents` takes a parameter typed
  `{ claude?: unknown; codex?: unknown; opencode?: unknown } | undefined`. That
  type drives `--all`, so add your key or `lrd apply --all` will never pick your
  agent up.

## Also, cosmetic but user-facing

`packages/cli/src/index.ts` - the `apply` command's argument description
(`'opencode | claude | codex'`), and a new `--<role> <model>` option declaration
if your agent needs a role flag of its own.
