# llm-runtime-dock

One local endpoint for your coding agents, with the right model loaded behind
it — whatever runtime that model happens to live in.

`lrd` was built with AI assistance — Claude Code and OpenCode, working against
both local and remote models. The agent instruction files it was developed with
ship with the repository (`AGENTS.md`, `CLAUDE.md`, `.claude/skills/`), where
they double as the contributor extension procedures.

## Why this exists

If you run models locally, you probably run more than one runtime: MTPLX for
one model, LM Studio for another, something else for the third. Each has its own
CLI, its own model names, its own idea of when it is ready — and none of them
agrees with the others about what "switch to another model" even means.

MTPLX serves one model per process, so switching means stopping the server and
starting it again with different flags. LM Studio keeps one shared server and
loads models into it, so switching is `lms unload` and then `lms load`. Your
machine, meanwhile, has exactly one pool of memory: leaving the old model
resident while the next one loads is how you run out of it.

Which leaves you doing the orchestration by hand — stop that one, start this
one, wait until it is really ready, hope nothing was mid-request — and then
editing three coding-agent config files because the model name changed.

`lrd` is the thing that does that for you. Your agents talk to one address, and
it starts, stops and switches the runtime underneath so that the model a request
asked for is the model that answers it: one switch at a time, in-flight requests
drained first, a live stream never cut. And since it already has to know what
your backends serve, it will write that into your agents' configuration too.

```text
OpenCode · Claude Code · Codex
        │  OpenAI or Anthropic API
        ▼
   llm-runtime-dock  ·  http://127.0.0.1:8787
        │  CLI / process control, plus documented HTTP lifecycle
        ▼
   MTPLX · LM Studio · oMLX · Ollama · your own runtime
```

Three commands, and none of them asks you to learn a new model format:

```bash
lrd probe mtplx --save   # ask the backend what it serves, save it as config
lrd serve                # one endpoint, the right model behind it
lrd apply claude         # point a coding agent at it
```

It is a gateway and orchestrator, not an inference engine. Everything it knows
about your machine comes from one YAML file you can read.

**Contents**

- [What it works with](#what-it-works-with)
- [Install](#install)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Coding agents](#coding-agents)
- [Commands](#commands)
- [API](#api)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Extending it](#extending-it)
- [Documentation](#documentation)
- [License](#license)

## What it works with

| runtime                          | `adapter`   | to free memory, `lrd` has to                            |
| -------------------------------- | ----------- | ------------------------------------------------------- |
| [MTPLX](https://mtplx.com)       | `mtplx`     | stop the server, then restart it                        |
| [LM Studio](https://lmstudio.ai) | `lm-studio` | run `lms unload`; the server stays up                   |
| [oMLX](https://omlx.ai)          | `omlx`      | POST an unload; the server stays up                     |
| [Ollama](https://ollama.com)     | `ollama`    | POST `keep_alive: 0`; the server stays up (OpenAI only) |
| your own                         | `custom`    | run the stop command you declare in YAML                |

Coding agents: **[OpenCode](https://opencode.ai)**,
**[Claude Code](https://code.claude.com/docs/en/overview)** and
**[Codex](https://github.com/openai/codex)** — `lrd apply` writes
the gateway into each one's own configuration file, merging with what is already
there.

Four official backends, four different mechanisms — and one endpoint in front of them.
Anything not in that table can still be driven through the `custom` adapter,
declaratively, without writing any TypeScript; a first-class adapter is a
package plus one line in the composition root. Contributions welcome — see
[Extending it](#extending-it).

## Install

```bash
npm i -g llm-runtime-dock
```

Node 24 or newer. This puts `lrd` on your `PATH`.

The package is a single bundled file with no runtime dependencies, so the
install pulls nothing else in.

## Quickstart

Five commands from nothing to a working setup:

```bash
lrd probe                     # what is running on this machine right now?
lrd probe mtplx --save        # write those findings into a config file
lrd doctor                    # check the result, and say which file it read
lrd serve                     # start the gateway on 127.0.0.1:8787
lrd apply opencode            # point a coding agent at it
```

### 1. See what you have

`lrd probe` needs no gateway and no configuration — it is how a configuration
gets written in the first place. It asks each backend what it serves:

```text
mtplx      http://127.0.0.1:8000   running, serving 1 model (mtplx)
             Qwen3.8-27B (context 131072)
lm-studio  http://127.0.0.1:1234   not running
omlx       http://127.0.0.1:8000   not this runtime
            a server answered /health, but it does not serve oMLX /v1/models/status
ollama     http://127.0.0.1:11434 running, serving 0 models, 2 installed

# configuration for the discovered models
# write it with: lrd probe <adapter> --save
runtimes:
  mtplx:
    adapter: mtplx
    port: 8000
models:
  Qwen3.8-27B:
    runtime: mtplx
    backend_model: Qwen3.8-27B
```

Every outcome is useful. **Not running** is an answer, not an error.
**Running, credential required** means the server answered health and then
refused discovery — give it a key with `--api-key-env <VAR>`. **Not installed**
means the runtime's own executable is missing, so nothing could be started here.
For most runtimes that is answered without asking anything over HTTP, because the
executable is how the gateway drives them at all; Ollama is driven entirely over
HTTP, so it asks first and a remote server is reported as running whether or not
`ollama` is on this machine. **Not this runtime** means something else has that
port: MTPLX and oMLX both default to 8000, while Ollama defaults to 11434. Each
adapter asks a server whether it is its own before claiming it, so discovery
never writes a config aimed at the wrong backend.

Two more flags for the awkward cases: `--interactive` asks per runtime what to
probe and with what, and `--start` brings up a backend that supports daemon-style
startup and probes it again. Ollama's foreground `serve` command is started by
`lrd serve`, not by `lrd probe --start`.

Nothing is written without `--save`, so that block is yours to copy and edit.

### 2. Save it

```bash
lrd probe mtplx --save            # or --dry-run first, to see the result
```

`--save` prints the path it is about to write, backs up the previous file,
refreshes only that runtime's entries, and leaves every other runtime's alone.
Name collisions fail the command and leave the file untouched rather than
picking a winner for you.

Re-probing later is safe. An entry that comes back keeps everything you put on
it — options, `extra_args`, `auth`, your comments — and only the fields
discovery owns (`adapter`, `host` and `port` on the runtime; `runtime` and
`backend_model` on the model) are brought up to date. An entry the probe _doesn't_ find is usually just an idle backend, so it
is never deleted behind your back: `--save` lists them and asks, enter keeps
them all, and `--force` removes them without asking. With no terminal
(`--json`, a pipe, CI) they are kept and named.

### 3. Check it

```bash
lrd doctor
```

`doctor` names the file it loaded, then validates adapters, options, reserved
arguments, executables on your `PATH`, endpoint connectivity, and every
`agents:` role. Run it whenever something looks wrong — it is the fastest way to
find out what.

### 4. Run it

```bash
lrd serve
```

The gateway listens on `127.0.0.1:8787` and stays in the foreground. Runtime
process output goes to its stdout, so this is the window to watch.

## Configuration

The first existing match wins:

1. `--config <path>`
2. `$LRD_CONFIG`
3. `./llm-runtime-dock.yaml` (project-local)
4. `$XDG_CONFIG_HOME/llm-runtime-dock/config.yaml`
5. `~/.config/llm-runtime-dock/config.yaml`

Every command reports which file it actually loaded. A complete, commented
example is in [`examples/config.yaml`](examples/config.yaml).

Two maps. `runtimes:` declares the servers this machine can talk to; `models:`
declares what to ask them for. The rule is one sentence: anything describing the
**server** is a runtime field, anything describing the **model** is a model
field.

> **Make sure your backends run on different ports.** Two adapters can name the
> same default — MTPLX and oMLX both land on `8000` — and only one server can
> have it. Move one in that backend's own settings and record it under
> `runtimes:`.

```yaml
server:
  host: 127.0.0.1
  port: 8787

runtimes:
  mtplx:
    adapter: mtplx
    port: 8001 # moved: oMLX keeps the 8000 default
  omlx:
    adapter: omlx
    port: 8000
    auth:
      api_key_env: OMLX_API_KEY # a variable name, never a value
  lmstudio:
    adapter: lm-studio
    port: 1234
  ollama:
    adapter: ollama
    port: 11434

models:
  coding-quality:
    runtime: mtplx
    backend_model: Qwen3.8-27B
    options:
      reasoning: 'on'
      reasoning_effort: high
      context_window: 131072
      max_tokens: 32768
    extra_args: [--batching-preset, agent]

  # Same runtime as coding-quality: one server, one resident model at a time.
  coding-fast:
    runtime: mtplx
    backend_model: Qwen3.6-35B-A3B

  omlx-small:
    runtime: omlx
    backend_model: llama-3b

  ollama-coder:
    runtime: ollama
    backend_model: llama3.2

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

That is the whole shape. [`examples/config.yaml`](examples/config.yaml) is the
same thing with every field commented, plus LM Studio, Ollama and a `custom` runtime.

Each agent gets the roles its own format has: `claude` names Anthropic's three,
`codex` and `opencode` a single model. Every value is a logical model id from
`models:` — except `reasoning_effort`, which is a codex setting rather than a
role, and is written through to its config as-is.

Clients send the logical id and never see the backend model:

```json
{ "model": "coding-quality", "messages": [] }
```

### Fields you will actually set

On a runtime:

| field                        | meaning                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| the key                      | the runtime's name; what a model's `runtime:` points at                      |
| `adapter`                    | `mtplx`, `lm-studio`, `omlx`, `ollama` or `custom`                           |
| `port` (and optional `host`) | where it serves. Omit it to take the adapter's own default                   |
| `options`                    | server-scoped options only — oMLX flags or Ollama environment-backed options |
| `auth`                       | optional upstream credential, as `api_key_env` or `api_key_file`             |

On a model:

| field             | meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| the key           | the logical model id clients send and `/v1/models` returns                |
| `runtime`         | the runtime that serves it. One that is not declared fails validation     |
| `backend_model`   | the model reference the runtime itself understands                        |
| `name` (optional) | name written into agent configs; falls back to `backend_model` when unset |
| `options`         | model-scoped launch options, validated against that adapter's schema      |
| `extra_args`      | raw argv escape hatch for flags the adapter does not name                 |
| `keep_resident`   | keep this model loaded instead of unloading it on a switch (below)        |
| `disabled`        | keep the entry in the file and never serve it (below)                     |

Put a server-scoped option on a model, or a model-scoped one on a runtime, and
validation says so and names the block it belongs in. `extra_args` needs a
command line to escape into, so the Ollama adapter refuses it outright: `ollama
serve` takes no flags, and everything it documents is an environment variable
reached through `options`.

`options` describe **how the runtime process starts**. Context and output limits
are start-time flags: the gateway never rewrites the fields of your request,
injects defaults, or adds anything you did not send. Changing an option means
changing configuration, and the runtime restarts on the next switch.

Quote `on`/`off`/`yes`/`no` option values. Some YAML parsers read them as
booleans and these runtimes expect the literal strings; validation rejects a
boolean rather than quietly coercing it.

### Arguments you cannot set

Some arguments belong to the gateway and are rejected rather than silently
merged: `--host`, `--port`, `--model`, served-id flags like `--identifier`,
`--api-key`, and idle-unload flags such as LM Studio's `--ttl` — an idle
auto-unload would drop the model behind the gateway's back and leave its view of
the world wrong. The check covers `extra_args` too, and the error names the
field to use instead. The full table, with the reasoning per flag, is in
[§12](docs/05-configuration.md#configuration).

### One model at a time

At most one model is resident in memory at any moment, across every adapter.
That is the default, and it is not something you tune by accident: one machine
has one memory pool.

For you that means two entries sharing a port is fine and normal — switching
between them restarts the runtime with different flags. It also means the
gateway will stop a single-model server it did not start, when that is the only
way to free memory, and will say so in the log:

```text
releasing foreign mtplx server on :8001 to free the resident slot
```

The reasoning is in [§8 of the specification](docs/03-lifecycle.md#lifecycle).

### Keeping one model always loaded

Sometimes one model should never leave memory — a small one a coding agent
reaches for constantly, to summarise a file or scan a repository, while the large
model you are actually working with stays put. Reloading a 27B every time the
agent wants a two-line summary costs more than the summary.

`keep_resident: true` on a model entry does that:

```yaml
runtimes:
  mtplx: { adapter: mtplx, port: 8001 }
  mtplx-resident: { adapter: mtplx, port: 8002 }

models:
  coding-quality:
    runtime: mtplx
    backend_model: Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality
  summariser:
    runtime: mtplx-resident
    backend_model: Youssofal/Qwen3.5-4B-MTPLX-Optimized-Quality
    keep_resident: true
```

The small model is loaded the first time something asks for it and is not
unloaded again for as long as the gateway runs, and switching to it no longer
evicts `coding-quality` either. Both stay in memory; requests still take turns,
one model answering at a time,
because they share a GPU. So this buys you **no reloading**, not parallelism.

Note the second runtime, on its own port. MTPLX serves one model per server, so
freeing its memory means stopping the server — which would take the kept model
with it. A kept model on MTPLX or a custom runtime therefore needs a runtime of
its own; put another entry on `mtplx-resident` and validation refuses the config
and tells you why. LM Studio, oMLX and Ollama hold several models on one server,
so there a kept entry can share the runtime with anything. Ollama requires
`max_loaded_models: 2` or greater when a runtime uses `keep_resident: true`.

Because that second runtime exists to hold one chosen model, you usually want it
out of discovery as well. `lrd probe` reads MTPLX's installed catalogue, which
belongs to the installation rather than to a port, so it would keep offering to
add every other model to a server that must serve exactly one:

```yaml
runtimes:
  mtplx-resident:
    adapter: mtplx
    port: 8002
    discovery: false
```

`lrd probe` then skips it entirely — and says so — while `lrd probe
mtplx-resident` still probes it when you ask by name. Nothing else changes: the
gateway starts, stops and proxies to it exactly as before.

`lrd status` shows what is loaded and which model is currently answering:

```text
resident:  coding-quality (mtplx, spawned)
kept:      summariser (mtplx, ready, 0 active)
serving:   summariser
```

Its lifetime is the gateway's. Stopping `lrd serve` releases everything loaded,
kept entries included — nothing would be left to free the memory otherwise, and
a model outliving the process that loaded it is exactly the leak this gateway
exists to prevent.

Nothing measures what this costs while it runs — that budget is yours. `lrd
doctor` warns if more than one entry is kept.

### Models you keep configured but never serve

A probe reports everything a backend has, and not all of it is something a
client should ask for: embedding models, a sidecar the backend loads on its own,
or simply a model that is installed and not wanted right now.

Deleting the entry does not help — the next `lrd probe --save` finds the model
again and writes it straight back. `disabled: true` is the way to say it:

```yaml
models:
  embeddings:
    runtime: lmstudio
    backend_model: nomic-embed-text-v1.5
    disabled: true
```

The entry stays in the file, `lrd models` and `lrd doctor` still show it, and a
re-probe refreshes it and leaves the flag alone. Everything else treats it as if
it were not there: it is missing from `/v1/models`, a request naming it gets a
404 saying it is disabled, no runtime is ever started for it, and `lrd apply`
does not write it into any coding agent's configuration.

Pointing an `agents:` role at a disabled model is not a config error — the rest
of the CLI keeps working — but `lrd apply` refuses to write that mapping, and
`lrd doctor` reports it first.

## Coding agents

```bash
lrd apply opencode
lrd apply claude
lrd apply codex
lrd apply --all                       # every agent named in agents:
lrd apply claude --opus coding-fast   # override the mapping for one run
lrd apply codex --dry-run             # print the result, write nothing
```

`apply` reads the `agents:` section and writes each agent's own configuration
file. It **merges** rather than replaces: every key it does not own survives —
your other providers, plugin lists, schema references and settings. It backs the
file up first, reports the path it wrote, and is idempotent.

It never writes a secret value. Where a format supports an environment-variable
reference it writes that; where none exists it refuses and tells you why.

Declaring the mapping in `agents:` rather than in flags is what makes this
survivable: after `lrd probe --save` changes your model list, re-running
`lrd apply --all` is one command with nothing to remember.

**You do not need an `agents:` block to start.** Applying an agent the config
does not mention still works:

- `lrd apply opencode` registers the provider with all your models and **leaves
  your default model alone** — if you already picked one in OpenCode, it stays;
- `lrd apply claude` and `lrd apply codex` ask which model each role should use,
  offering your configured model ids, and print the `agents:` block to paste in
  so they stop asking.

A role can be left unset, and choosing nothing writes nothing. In a pipeline or
under `--json` there is no terminal to ask on, so the command fails with a clear
message rather than hanging.

`--all` is the exception: it applies to the agents named in `agents:` and no
others, so it never stops to ask. Name an agent explicitly to set it up without
a mapping.

An entry can only fill an Anthropic role if its runtime serves that surface.
`apply` and `doctor` both check before a client ever hits it.

## Commands

```text
lrd serve                     start the gateway
lrd status                    what a running gateway is doing
lrd probe [runtime]           ask the backends what they serve
lrd apply <agent> | --all     write the gateway into an agent's config
lrd doctor                    validate config, adapters, executables, roles
lrd models                    configured logical ids
lrd runtimes                  declared runtimes, their models and state
lrd switch <model>            make a model resident, through the scheduler
lrd logs <runtime>            captured runtime process output
```

`--config <path>`, `--json` and `--no-color` work on every command;
`--endpoint <url>` on the ones that talk to a running gateway.

Output is coloured only when `lrd` owns the terminal: `--no-color`, `NO_COLOR`,
`--json`, `TERM=dumb` and any pipe or redirect turn it off, and `FORCE_COLOR`
turns it back on where there is no terminal to detect. The colour is decoration
only — strip the escapes and the bytes match the uncoloured run.

`status` and `switch` are HTTP clients of a running gateway. With no gateway they
say so plainly and exit non-zero — never a stack trace:

```text
error [GATEWAY_NOT_RUNNING] gateway not running at http://127.0.0.1:8787
hint: start it with `lrd serve`
```

`lrd apply --all` applies to every agent named in `agents:`. An agent that is not
installed is reported and skipped so the others still get written; the command
still exits non-zero.

Runtime process output is held by the `serve` process that spawned it, so
`lrd logs` run as a separate command has nothing to show. Follow `lrd serve`'s
own output instead. There is deliberately no `--follow`: streaming logs out of
the gateway would mean a new HTTP endpoint, and the surface is kept to the one in
the specification.

## API

```http
GET  /health
GET  /v1/models
POST /v1/chat/completions
POST /v1/messages
POST /v1/messages/count_tokens
GET  /status                  loopback only
POST /switch                  loopback only
```

Both supported surfaces are **proxied, never translated** — compatible backends
serve them themselves. MTPLX, LM Studio and oMLX expose both OpenAI and Anthropic;
Ollama exposes OpenAI only. SSE streaming passes through unaltered, and tool calls
work because nothing rewrites them.

Request bodies are touched in exactly one place: the `model` field, swapped from
your logical id to the one the backend answers to. Not `tools`, not
`tool_choice`, not `messages`. `GET /v1/models` returns your configured logical
ids whether or not they are loaded, and your `Authorization` header goes
upstream verbatim — a per-model `auth:` block fills in only when you sent none,
and the gateway never generates a key.

The full surface, both protocols, response-header handling and `/switch`
semantics are in [§14](docs/06-gateway-api.md#gateway-api).

## Troubleshooting

**`lrd status` says the gateway is not running.** It is an HTTP client; start
`lrd serve`, or point it somewhere else with `--endpoint`.

**A command reads a different config than you are editing.** Every command prints
the file it loaded — check that line first. A project-local
`./llm-runtime-dock.yaml` that did not exist when you last saved means the save
landed in your home config instead.

**`RUNTIME_MODEL_MISMATCH`.** The runtime came up but is not serving the
`backend_model` this entry asked for. Run `lrd probe <adapter>` to see what it
actually serves, and fix `backend_model` to match.

**`RUNTIME_MODEL_PINNED`.** A pinned model is holding memory and cannot be
evicted, so the switch would have left two models resident. Unpin it in the
runtime — the error names which one.

**`UPSTREAM_SURFACE_UNSUPPORTED`.** You sent an Anthropic request to a runtime
that only serves OpenAI. A `custom` entry serves OpenAI only unless it opts in
with `surfaces: [openai, anthropic]`.

**`RUNTIME_OPTION_RESERVED` at startup.** An option or `extra_args` entry uses a
flag the gateway owns. The message names the canonical field to use instead.

**LM Studio: a server answers on a different port.** `lms server start --port`
only decides the port when no server is running; otherwise LM Studio reuses the
port from its last start. The error names both ports — either point the entry at
the running one or restart LM Studio's server.

**A switch hangs, then fails with `RUNTIME_SLOT_BUSY`.** Something is holding a
stream open. Cancel the client, or raise the drain timeout.

**Tool calls arrive as text instead of being executed.** Your agent shows raw
`<function_calls>` or similar markup in the reply. The gateway does not touch
`tools` or `tool_choice`, so this is the runtime rendering tools in a format its
own parser did not read back. For MTPLX the relevant launch options are
`tool_prompt_mode`, `chat_template_profile` and `agent_rewrites` — none of them
is set for you, because the right value depends on the model. To confirm where
the problem is rather than guess, capture the traffic instead:

```bash
lrd serve --debug                    # one file per run; path printed on start
lrd serve --debug --debug-dir ./cap  # or put it where you choose
```

The capture is a tee — it cannot alter what is sent — and it records both hops,
so you can compare what reached the runtime with what the client got. Header
credentials are redacted; **bodies are not**, so the file holds whole
conversations. Treat it as sensitive. The event format and the `jq` recipes for
reading one are in [§14](docs/06-gateway-api.md#gateway-api); the flags, their
defaults and the `LRD_DEBUG` environment variables are in
[§27](docs/10-cli.md#cli).

When in doubt, `lrd doctor` checks the whole configuration in one pass and names
the file it read.

## Security notes

The gateway binds to `127.0.0.1` and has no authentication. `/status` and
`/switch` are lifecycle controls: loopback-only, and refused outright when the
gateway is bound to a non-loopback address.

Lifecycle commands are **trusted configuration only**. Nothing derived from an
HTTP request is ever interpolated into a command — a request selects which
configured entry runs, never what it runs.

Commands are argv arrays, used verbatim:

```yaml
command: [some-runtime, serve, --model, some-model-7b] # preferred
```

Shell execution exists but must be opted into explicitly:

```yaml
process:
  start:
    command: ['some-runtime serve | tee log']
    shell: true
```

With `shell: true` the string is handed to the system shell, so every shell
metacharacter in it is live — quoting, globbing, redirection, command
substitution. Use it only for a command you wrote yourself, and prefer the argv
form, which cannot be reinterpreted.

`lrd apply` never writes a credential into a coding agent's configuration, only
an environment-variable reference.

The normative rules are in [§28](docs/01-overview.md#security).

## Extending it

Contributions are welcome, and there are two ways in — one of which is not code
at all.

**A runtime, without writing TypeScript.** Any runtime the built-in adapters do
not cover can be described declaratively: the start and stop commands, the
health and model-discovery URLs, and the endpoint to proxy to. That is the
`custom` adapter, and it is a `runtimes:` entry like any other. See `legacy`
in [`examples/config.yaml`](examples/config.yaml), and
[§11](docs/04-adapters.md#custom-adapter) for the full field list.

**A first-class adapter or agent.** Worth it when a runtime needs real logic —
mapped launch options, its own readiness check, a CLI to drive. The workspace is
laid out so this stays small:

1. Create the package under `packages/runtimes/<name>` or
   `packages/agents/<name>`, implementing `RuntimeAdapter` or `AgentIntegration`
   from `@llm-runtime-dock/core`.
2. Add it as `workspace:*` where it is used, and run `pnpm install`. There is no
   build graph to update — it is derived from those dependencies.
3. Register it in the composition root, `src/index.ts`, which is a list:

   ```ts
   export const defaultAdapters = (logger?: Logger): RuntimeAdapter[] => {
     return [
       createMtplxAdapter(logger ? { logger } : {}),
       createLmStudioAdapter(logger ? { logger } : {}),
       // your adapter here
     ];
   };
   ```

That is the whole registration. Nothing in `packages/core` knows an adapter
exists — the composition root is the only file that imports one, which is what
keeps a new backend from touching the core at all.

The `RuntimeAdapter` and `AgentIntegration` contracts are in
[§7](docs/04-adapters.md#runtime-adapter-interface) and
[§23](docs/08-agents.md#agent-integrations); the build, test and style
workflow is in [Architecture](docs/02-architecture.md#developer-experience).

## Documentation

The complete specification lives in [`docs/`](docs/README.md) — the design, the
invariants, and the reasoning behind the decisions that are easy to get wrong.

## License

MIT — see [LICENSE](LICENSE).
