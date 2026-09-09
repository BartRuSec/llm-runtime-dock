# Configuration

Where configuration lives, the shape of a model entry, the arguments the
gateway reserves for itself, and how a client's model id resolves to a runtime.

---

## Configuration

#### Where configuration lives

The first existing match wins:

```text
1. --config <path>
2. $LRD_CONFIG
3. ./llm-runtime-dock.yaml                        (project-local)
4. $XDG_CONFIG_HOME/llm-runtime-dock/config.yaml
5. ~/.config/llm-runtime-dock/config.yaml
```

Commands that write configuration ([§22](07-discovery.md#runtime-discovery)) write to **the file resolution actually found**. Only when resolution finds nothing do they create `~/.config/llm-runtime-dock/config.yaml`.

This matters: a project-local `./llm-runtime-dock.yaml` that does not exist yet cannot be found, so a first save lands in the home config, and creating the project file by hand later silently moves the target. Writing commands therefore print the path they are about to write before writing it.

Every command reports which file it actually loaded. A gateway silently reading a different config than the user is editing is a whole class of confusing bug.

#### Shape

There are two maps. `runtimes:` declares the servers this machine can talk to;
`models:` declares what to ask them for. The split rule is one sentence:
**anything that describes the server or the endpoint is a runtime field, anything
that describes the model is a model field.**

A key in `runtimes:` is a **declared runtime** ([§3](01-overview.md#terminology));
a key in `models:` is the logical model id the client sends and the gateway
advertises.

```yaml
server:
  host: 127.0.0.1
  port: 8787

runtimes:
  mtplx:
    adapter: mtplx
    port: 8000
  lmstudio:
    adapter: lm-studio
    port: 1234
  omlx:
    adapter: omlx
    port: 8000
    options:
      model_dir: ~/models/omlx
      memory_guard: balanced
    auth:
      api_key_env: OMLX_API_KEY
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
      profile: turbo
      context_window: 131072
      max_tokens: 32768
    extra_args: [--batching-preset, agent]

  coding-fast:
    runtime: mtplx
    backend_model: Qwen3.6-35B-A3B
    options:
      reasoning: 'off'
      depth: 3
      context_window: 131072

  local-lmstudio:
    runtime: lmstudio
    backend_model: qwen2.5-coder-32b
    options:
      context_length: 131072
      gpu: max

  omlx-coder:
    runtime: omlx
    backend_model: Ornith-1.5-35B-A3B-oQ6e-fixed-mtp

  omlx-small:
    runtime: omlx
    backend_model: llama-3b

  ollama-coder:
    runtime: ollama
    backend_model: llama3.2
```

#### Fields

A declared runtime:

| field                                                 | meaning                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| key                                                   | the declared runtime's name; what a model's `runtime:` points at                                                                    |
| `adapter`                                             | which runtime adapter drives this server                                                                                            |
| `port` (and optional `host`)                          | the server endpoint. Omitted, the adapter's own default applies ([§22](07-discovery.md#runtime-discovery))                          |
| `options`                                             | **server-scoped** launch options only — the keys the adapter names in `serverScopedOptionKeys`. A model-scoped key here is rejected |
| `auth`                                                | optional upstream credential. A credential is a property of the server, not of a model                                              |
| `surfaces`                                            | which API surfaces this server serves. `adapter: custom` only                                                                       |
| `process` / `health` / `model_discovery` / `endpoint` | the custom adapter's declarative blocks ([§11](04-adapters.md#custom-adapter))                                                      |
| `discovery`                                           | whether `lrd probe` may look at this runtime ([§22](07-discovery.md#runtime-discovery)); defaults to `true`                         |

A model:

| field             | meaning                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| key               | logical model id; what the client sends and what `/v1/models` returns                                                                             |
| `runtime`         | the declared runtime that serves it. Naming one that is not declared fails with `CONFIG_INVALID` — there is no implicit fallback to an adapter id |
| `backend_model`   | the model reference the runtime itself understands                                                                                                |
| `name` (optional) | the name written into agent configurations (opencode, codex, claude); when unset it falls back to `backend_model`                                 |
| `options`         | **model-scoped** launch options, validated by that adapter's schema. A server-scoped key here is rejected                                         |
| `extra_args`      | raw argv escape hatch for options the adapter does not name                                                                                       |
| `keep_resident`   | never unload this entry on a switch ([§8](03-lifecycle.md#lifecycle)); defaults to `false`                                                        |
| `disabled`        | keep this entry recorded and never serve it (below); defaults to `false`                                                                          |

Quote `on`/`off`/`yes`/`no` option values. Some YAML parsers read them as booleans, and these runtimes expect the literal strings. Config validation should reject a boolean where an adapter declares an enum, rather than coercing it.

#### Two backends, two ports

**Give every backend its own port.** Two adapters may name the same default —
MTPLX and oMLX both default to `8000`, while Ollama defaults to `11434` — and two
servers cannot listen on one port.

A probe survives the clash honestly: it asks each server whether it is that
runtime's own before claiming it, so discovery never writes a configuration
aimed at the wrong backend ([§22](07-discovery.md#runtime-discovery)). That is
detection, not a fix — the runtime that lost the port still has nowhere to
listen, and every switch to a model on it fails at request time.

Move one in the runtime's **own** settings, since the port a backend binds is
that backend's configuration, and record the new value here. `port:` tells the
gateway where to look and what to pass on a launch command; it does not
reconfigure a server somebody else started. `examples/config.yaml` puts MTPLX on
`8001` for exactly this reason.

#### Keeping one model resident

`keep_resident: true` takes an entry out of the rotation ([§8](03-lifecycle.md#lifecycle)): it is loaded on first use and never unloaded by a switch, and reaching it does not evict whatever else is loaded. It is not unloaded by anything else either, until the gateway stops — its lifetime is the process's, because nothing outside that process would free it. It is a scheduling decision, not a launch option, which is why it is a field of its own rather than a key under `options:` — it renders no flag, and no adapter validates it.

Whether an entry _can_ be kept depends on its runtime, and the check happens at config load rather than on the first failed switch:

- an `unload_model` runtime (LM Studio, oMLX, Ollama) holds several models at once, so a kept entry may share it with anything;
- a `stop_server` runtime (MTPLX, custom) serves one model per server, so a kept entry must own its runtime alone. Starting any other entry on that runtime means stopping the server, which would unload the model the flag exists to protect.

The second case fails with `CONFIG_INVALID`, naming the entries that share the server. The fix is a second runtime on its own port:

```yaml
runtimes:
  mtplx: { adapter: mtplx, port: 8000 }
  mtplx-resident: { adapter: mtplx, port: 8001 }

models:
  coding-quality:
    runtime: mtplx
    backend_model: Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality
  summariser:
    runtime: mtplx-resident
    backend_model: Youssofal/Qwen3.5-4B-MTPLX-Optimized-Quality
    keep_resident: true
```

The port is checked as well as the runtime key: two runtime entries aimed at one port are one server, and `mtplx stop --port 8000` does not care which YAML key asked for it.

Nothing stops several entries carrying the flag, and nothing measures what that costs — the memory budget is the user's ([§29](03-lifecycle.md#memory--resource-policy)). `doctor` warns past the first.

#### Models that are configured and not served

`disabled: true` on a model entry keeps it in the file and out of everything else:

- it is omitted from `GET /v1/models` ([§15](06-gateway-api.md#gateway-api));
- a request naming it is refused with `MODEL_NOT_FOUND`, so it never reaches the scheduler and can never take the resident slot ([§13](#configuration));
- `lrd apply` neither registers it in a provider block nor accepts a role that names it ([§23](08-agents.md#coding-agent-integration)).

That is what makes it different from deleting the entry. A probe finds the model
either way, so a deleted entry comes straight back on the next `lrd probe --save`;
a disabled one is refreshed in place and keeps the flag, because discovery only
ever writes `runtime` and `backend_model` on an entry that already exists
([§22](07-discovery.md#runtime-discovery)). Discovery never writes `disabled`
itself, and a disabled entry whose backend a probe no longer reports goes stale
like any other — the flag says "do not serve it", not "do not manage it".

The case it exists for is a model the machine really has and a client should
never ask for: an embedding model, a sidecar the backend loads on its own, or
simply one that is installed and not wanted right now.

```yaml
models:
  embeddings:
    runtime: lmstudio
    backend_model: nomic-embed-text-v1.5
    disabled: true
```

Disabling a model an `agents:` role names is **not** a configuration error.
Loading the file has to keep working — otherwise disabling one entry would stop
`lrd serve`, `lrd models`, `lrd doctor` and `lrd probe` until the `agents:`
block was edited too. `lrd apply` refuses that mapping when it runs, and
`doctor` reports it as an `error` beforehand.

`keep_resident` on a disabled entry does nothing, since nothing loads it;
`doctor` warns rather than failing, because temporarily disabling a kept model
is a normal thing to do.

The flag is a `models:` field only. There is no `disabled` on a `runtimes:`
entry — a runtime with no enabled model on it is already inert, and `doctor`
reports it.

#### Reserved arguments

Some arguments belong to the gateway and must be **rejected** in `options` and `extra_args`, not silently merged:

| reserved                                                         | why                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--host`, `--port`                                               | core must know the proxy target and the health-check URL                                                       |
| `--model`, and any served-id flag (`--model-id`, `--identifier`) | overriding it silently breaks model identity verification ([§17](03-lifecycle.md#model-identity-verification)) |
| `--api-key`, `--api-key-file`                                    | upstream auth is configured explicitly ([§12](#configuration))                                                 |
| runtime idle-unload flags (e.g. LM Studio `--ttl`)               | the model would unload behind the gateway's back, leaving its state stale                                      |

Each adapter declares its own reserved list. Violations fail config loading with `RUNTIME_OPTION_RESERVED` and are reported by `doctor`, with a message naming the canonical field to use instead.

This check applies to `extra_args` as well, otherwise the escape hatch reintroduces the problem.

`coding-quality` and `coding-fast` sharing a runtime is valid: only one model is resident at a time ([§8](03-lifecycle.md#lifecycle)), so switching between them restarts the process with different flags.

#### Coding agents

An optional `agents:` block records which model each coding agent should use, and in which role. It is what `lrd apply` reads ([§23](08-agents.md#agent-integrations)):

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

Every value is a logical model id from `models:`. Unknown ids fail validation, so a rename caught by `doctor` beats a coding agent silently pointing at nothing.

#### Server-scoped options

Some options configure the **server**, not the model: oMLX's `model_dir`,
`memory_guard`, `max_concurrent_requests`; LM Studio's bind address.

They live on the declared runtime, which is what makes two models on one server
structurally unable to disagree about it: there is one value, in one place. A
flat `models:` map would instead let two entries on one `host:port` write
different values.

The split is enforced from the adapter's own `serverScopedOptionKeys`
([§7](04-adapters.md#runtime-adapter-interface)): a server-scoped key in a
model's `options` is rejected and told where it belongs, and so is a model-scoped
key on a runtime. An adapter that declares no server-scoped keys at all — MTPLX
and LM Studio — therefore rejects any `options:` on its runtime entry, which is
the clearest possible statement that it has none.

Core merges the runtime's options under the model's and hands the adapter one
record, so an adapter still has one schema and one argument renderer. The two
blocks cannot overlap, because the scope check runs first.

Server-scoped options only take effect when the gateway spawns the server. When
it attaches to a running one, they are ignored — `doctor` says so rather than
pretending they applied.

#### Launch options, not request rewriting

`options` describe **how the runtime process starts**. Context and output limits map to start-time flags (`--context-window` / `--max-tokens` for MTPLX, `-c` for LM Studio).

The gateway does not rewrite fields of the OpenAI request body. It does not inject defaults into `max_tokens`, `temperature`, `reasoning_effort` or anything else the client sent, and it does not add fields the client omitted.

Changing an option means changing configuration and restarting the runtime — not sending a different request.

One precision, because it is the kind of claim that gets read as more than it says: the guarantee is about **fields**, not bytes. Replacing the `model` value means parsing the body and serializing it again, so what leaves the gateway is a re-encoding of what arrived — duplicate keys collapse to the last, number formatting normalizes (`1.50` → `1.5`), integers past 2^53 lose precision, and whitespace is gone. No field is added, removed or changed except `model`. For OpenAI and Anthropic payloads the difference is invisible; when it matters, `lrd serve --debug` ([§14](06-gateway-api.md#gateway-api)) shows the exact bytes that were sent.

#### Upstream authentication

The gateway does not generate, manage or inject backend API keys, and adapters must not add auth flags to the launch command on their own. Interfere with the backend endpoint as little as possible.

- By default the client's `Authorization` header is forwarded upstream verbatim.
- An optional `auth` block on the **declared runtime** supplies a credential for outbound requests (proxy, health, model discovery) **only when the client sent none**. It sits there rather than on a model because it is a property of the server every model on it reaches:

```yaml
auth:
  api_key_env: MY_RUNTIME_KEY
  # or: api_key_file: ~/.some-runtime/api-key
```

- If a runtime should _require_ a key, the user opts in through `extra_args` on their side.
- Credentials are never logged and never appear in `examples/config.yaml` ([§28](01-overview.md#security)).
- An upstream 401/403 maps to `UPSTREAM_UNAUTHORIZED`, not to a generic failure.

### The example configuration

`examples/config.yaml` is part of the contract, not a scratch file. It must:

- be safe to copy and edit as-is — every value in it is either a real default or
  an obvious placeholder;
- cover both `options` and `extra_args`, so the difference between a curated
  option and the raw argv escape hatch is visible without reading this document;
- contain no secret, and reference **no `api_key_file`**. It demonstrates
  `api_key_env` only: a path to a key file on the author's machine is not a
  credential, but it is a working example of the one habit this project does not
  want to teach.

`lrd doctor --config examples/config.yaml` must pass against it.

---

## Model Resolution

Clients use logical model names.

Examples:

```text
coding-fast
coding-quality
local-lmstudio
```

or namespaced:

```text
llm-runtime-dock/coding-fast
llm-runtime-dock/coding-quality
```

The gateway resolves:

```text
client model id
   ↓
models[] entry
   ↓
runtimes[] entry  (adapter + endpoint)
   ↓
adapter + launch options  (runtime instance)
   ↓
actual backend model
```

Even though configuration is flat, resolution stays a distinct step in core. The gateway API talks to a resolved target, never directly to a config entry, so later features (variants sharing one process, hot reconfiguration) can change resolution without touching HTTP handling.

The actual backend model name must not need to be exposed to the client.
