# Coding agent integrations

How `lrd apply` writes the gateway into OpenCode, Claude Code and Codex
configuration without clobbering what the user already had there.

---

## Agent Integrations

A coding agent is only useful against this gateway once it knows the gateway exists. Writing that configuration by hand — a provider block, a base URL, a model list, role mappings — is exactly the friction the project set out to remove.

`lrd apply <agent>` writes it, from the configuration the gateway already has.

#### Each agent is a plugin

Agents differ more than runtimes do: different files, different formats, different notions of "model". So each lives in its own package and implements a small interface:

```ts
interface AgentIntegration {
  readonly id: string; // "opencode" | "claude" | "codex"
  readonly displayName: string;
  readonly surface: 'openai' | 'anthropic';

  /** Role names this agent understands. */
  readonly roles: readonly string[];

  /** Is a role mapping the only thing that makes applying useful? */
  readonly requiresRoleMapping: boolean;

  /** Where this agent's configuration lives. */
  configPath(): string;

  /** Is the agent installed at all? */
  isInstalled(): Promise<boolean>;

  /** Produce the file content this agent needs. Pure: no writes. */
  render(plan: ApplyPlan): Promise<RenderedConfig>;
}
```

`render` is deliberately pure so that `--dry-run` and the real write share one code path.

#### When the configuration names no roles

`agents:` is optional, and an agent may be applied that it does not mention.
What happens then depends on whether the agent's provider block is useful on its
own — which is what `requiresRoleMapping` records.

| agent      | `requiresRoleMapping` | with no entry in `agents:`                                                                                              |
| ---------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `opencode` | `false`               | the provider block is written with every configured model; the user's own default model selection is **left untouched** |
| `claude`   | `true`                | the CLI asks which model each of opus/sonnet/haiku should use                                                           |
| `codex`    | `true`                | the CLI asks which model to use                                                                                         |

OpenCode's provider block registers the models by itself, so applying is still
worth doing without a mapping — and the default model is a choice the user may
well have made deliberately in OpenCode, possibly pointing at a provider that is
none of the gateway's business. Overwriting it would be the tool deciding
something it was not asked to decide.

Claude Code has no provider concept at all: the roles _are_ the model selection,
so a file written without them points at nothing. Codex needs `model` alongside
`model_provider` for the same reason. Rather than fail, the CLI asks — the
choices are the logical model ids the configuration already declares, which is a
short list the user wrote themselves. A role can be left unset, and choosing
nothing at all writes nothing.

Asking is a terminal affordance, so it belongs to the CLI rather than to core
([§27](10-cli.md#cli)): `applyAgent` takes a resolved mapping and never prompts.

Core knows nothing about provider blocks or TOML tables, exactly as it knows nothing about CLI flags ([§6](02-architecture.md#core-architecture)).

#### What apply is built from

Three inputs:

1. the gateway endpoint, from `server` ([§12](05-configuration.md#configuration));
2. the model entries, which become the agent's model list — every one that is served, which excludes anything carrying `disabled: true` ([§12](05-configuration.md#configuration));
3. the `agents:` section ([§12](05-configuration.md#configuration)), which says which entry plays which role:

```yaml
agents:
  claude:
    opus: coding-quality
    sonnet: coding-quality
    haiku: coding-fast
  codex:
    model: coding-quality
    reasoning_effort: high
  opencode:
    default: coding-quality
```

Declaring the mapping in configuration rather than in flags keeps `apply` idempotent and survivable: after a `probe --save` changes the model list, re-running `apply` is one command with no arguments to remember. CLI flags override for a one-off.

#### Two protocols, two base URLs

OpenCode and Codex speak OpenAI and use `/v1/chat/completions`. Claude Code speaks Anthropic and uses `/v1/messages` ([§14](06-gateway-api.md#gateway-api)).

Their base-URL conventions differ, and the difference is load-bearing:

```text
OpenCode  baseURL          http://127.0.0.1:8787/v1
Codex     base_url         http://127.0.0.1:8787/v1
Claude    ANTHROPIC_BASE_URL   http://127.0.0.1:8787
```

Claude Code appends `/v1/messages` itself. Do not normalize these into one form for consistency; each convention belongs to its agent plugin.

#### Protocol support gates the mapping

An entry can only fill an Anthropic role if its adapter serves the Anthropic surface. Adapters declare this through `capabilities()` ([§7](04-adapters.md#runtime-adapter-interface)).

MTPLX, LM Studio and oMLX all serve both surfaces. Ollama, like `custom`, is OpenAI-only because it does not provide an Anthropic surface.

The check happens at `lrd apply` and at `lrd doctor`, never at first request. Discovering the mismatch when Claude Code is already pointed at a dead configuration is the outcome worth designing away.

#### Writing into files someone else owns

Agent configuration files belong to the user, not to the gateway. Every apply:

- writes back to **the file that exists** — an `opencode.jsonc` stays `.jsonc`, it does not become `.json`;
- **merges**, preserving every key it does not own. Schema references, plugin lists, disabled providers, unrelated provider blocks and the user's own settings all survive;
- touches only the provider block the gateway owns plus the keys the `agents:` mapping names;
- backs up the previous file first, and reports the path it wrote;
- is idempotent: running it twice produces the same file.

If comments or key order cannot be preserved through a rewrite, warn before writing rather than reformatting silently. A hand-maintained JSONC file with comments is a normal thing to find.

Existing providers that point straight at a backend are left alone. Bypassing the gateway is a legitimate thing for a user to have configured, and removing it is their call, not the tool's.

#### Never write a secret

If a model entry carries `auth` ([§12](05-configuration.md#configuration)), apply writes an **environment-variable reference** where the agent's format supports one, and refuses with an explanation where it does not. It never resolves the variable and inlines the value.

On the common path there is no credential at all: the gateway listens on loopback without authentication, so the agent needs none to reach it.

#### Per-agent shapes

**OpenCode** — merges a provider into `~/.config/opencode/opencode.json` (or the `.jsonc` that exists):

```jsonc
{
  "provider": {
    "llm-runtime-dock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LLM Runtime Dock",
      "options": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": {
        "coding-quality": {
          "name": "Qwen3.8-27B",
          "limit": { "context": 131072, "output": 32768 },
        },
      },
    },
  },
}
```

Context and output limits come from the entry's launch options where they are known; a limit the gateway cannot state is omitted rather than guessed.

**Codex** — merges into `~/.codex/config.toml`:

```toml
model = "coding-quality"
model_provider = "llm-runtime-dock"

[model_providers.llm-runtime-dock]
name = "llm-runtime-dock"
base_url = "http://127.0.0.1:8787/v1"
```

**Claude Code** — merges an `env` block into `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "coding-quality",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "coding-quality",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "coding-fast"
  }
}
```

Claude Code has no provider concept; roles are the model selection. That is why `agents.claude` names roles while the others name a default.

#### Failure cases

- the agent is not installed → say so and exit non-zero, without writing;
- a role names an unknown model id → `MODEL_NOT_FOUND`;
- a role names an entry with `disabled: true` → `CONFIG_INVALID`, at apply time rather than at config load, so disabling one entry never stops the rest of the CLI from reading the file ([§12](05-configuration.md#configuration));
- a role names an entry whose adapter lacks the required surface → `AGENT_SURFACE_UNSUPPORTED`;
- an entry needs a credential the agent's format cannot reference → `AGENT_SECRET_UNSUPPORTED`;
- the configuration file cannot be parsed → back off and report, never overwrite something unreadable.

---

## Example Agent Usage

The gateway should present one stable endpoint:

```text
http://127.0.0.1:8787/v1
```

OpenCode and Codex send:

```json
{
  "model": "coding-quality",
  "messages": [...]
}
```

Claude Code sends the same logical id to `/v1/messages` instead, having been pointed there by `lrd apply claude`.

Neither agent was configured by hand.

The gateway decides which runtime must be active.

The coding agent does not need to know:

```text
MTPLX
Qwen3.8-27B
process IDs
startup commands
launch flags
health endpoints
switching logic
```

This separation is a primary product goal.
