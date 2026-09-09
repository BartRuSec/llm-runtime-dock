# Runtime adapters

The adapter contract, and how each of the five shipped adapters implements it.

---

## Runtime Adapter Interface

Define a deliberately small stable interface.

Conceptually:

```ts
interface RuntimeAdapter {
  readonly id: string;

  /** How this adapter frees the resident model slot ([§8](03-lifecycle.md#lifecycle)). */
  readonly modelRelease: 'unload_model' | 'stop_server';

  /**
   * Validate and normalize adapter-specific launch options from config.
   * Called at config load time, not per request.
   */
  validateOptions(raw: unknown): RuntimeOptions;

  /** Questions `lrd probe --interactive` renders for this adapter ([§22](07-discovery.md#runtime-discovery)). */
  readonly probeQuestions: readonly ProbeQuestion[];

  /**
   * Ask a running server of this runtime what it serves.
   * Runs before any config entry exists — see [§22](07-discovery.md#runtime-discovery).
   */
  probe(target: ProbeTarget): Promise<DiscoveredModel[]>;

  /** Bring this runtime's server up from a probe, where that is possible at all. */
  startServer?(target: ProbeStartTarget): Promise<ProbeStartResult>;

  /**
   * Make this instance the resident model.
   * Attaches to a running server or spawns one, then loads the model.
   * `options.keepLoaded` names served ids on this same runtime that another
   * entry keeps resident ([§8](03-lifecycle.md#lifecycle)) and must survive.
   */
  acquire(runtime: RuntimeInstance, options?: AcquireOptions): Promise<void>;

  /** Free the resident slot using this adapter's release mechanism. */
  release(runtime: RuntimeInstance): Promise<void>;

  start(runtime: RuntimeInstance): Promise<void>;

  stop(runtime: RuntimeInstance): Promise<void>;

  health(runtime: RuntimeInstance): Promise<HealthStatus>;

  waitUntilReady(runtime: RuntimeInstance, options?: WaitOptions): Promise<void>;

  listModels(runtime: RuntimeInstance): Promise<ModelInfo[]>;

  /** Includes which API surfaces this runtime serves: openai, anthropic. */
  capabilities(runtime: RuntimeInstance): Promise<Capabilities>;

  endpoint(runtime: RuntimeInstance): Promise<Endpoint>;
}
```

The shipped contract is the sketch above plus five members that the rest of these
documents require and that could not live in core, because each of them is
adapter knowledge exactly as CLI flags are:

| member                | required by                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `verifyIdentity`      | [§17](03-lifecycle.md#model-identity-verification) — the source of truth differs per adapter                 |
| `servedModelId`       | [§13](05-configuration.md#model-resolution) — the id the upstream answers to is not the configured reference |
| `declaredLimits`      | [§23](08-agents.md#agent-integrations) — context/output limits for an agent’s model list                     |
| `requiredExecutables` | [§27](10-cli.md#cli) — `doctor` reporting a missing binary before a switch fails on it                       |
| `logs`                | [§27](10-cli.md#cli) — `lrd logs`                                                                            |

In practice it grew rather than shrank, because five operations elsewhere in this
document have no other home:

| member                | required by                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `verifyIdentity`      | [§17](03-lifecycle.md#model-identity-verification) — the source of truth differs per adapter                        |
| `servedModelId`       | [§13](05-configuration.md#model-resolution) — the id the upstream answers to, which is not the configured reference |
| `declaredLimits`      | [§23](08-agents.md#agent-integrations) — context/output limits for an agent's model list                            |
| `requiredExecutables` | [§27](10-cli.md#cli) — `doctor` reporting a missing binary before a switch fails on it                              |
| `logs`                | [§27](10-cli.md#cli) — `lrd logs`                                                                                   |

Each is adapter knowledge, exactly like the CLI flags, so none of them could live
in core.

Do not expose implementation-specific concepts through the core interface.

#### Launch options

A `RuntimeInstance` carries the validated `options` and `extra_args` from its config entry.

Core treats them as opaque. Only the adapter knows how they become CLI arguments.

Core must not implement a generic `key` → `--kebab-flag` renderer. Real runtimes have flag aliases, mutually exclusive flags and `--no-*` flags that are not negations; a renderer handling those correctly would need per-flag metadata, which is exactly the adapter's schema, living in the wrong package.

Each adapter therefore exposes:

- a **curated set of named options** it validates and maps to documented flags;
- **`extra_args`**, a raw argv array for the long tail.

`endpoint()` also returns the outbound auth header, if any, that core must attach to upstream requests (see [§12](05-configuration.md#configuration)).

`probe()` deliberately does not take a `RuntimeInstance` or a config entry. Discovery exists to _produce_ configuration, so it cannot require it ([§22](07-discovery.md#runtime-discovery)). `startServer()` takes a plain host and port for the same reason — and that is exactly why it is not `start()`, which needs a `backend_model` a probe has not got.

#### Two layers: server and slot

`start` / `stop` are the **server** layer: they bring a serving process up or down.

`acquire` / `release` are the **resident slot** layer ([§8](03-lifecycle.md#lifecycle)): they make one model resident, or free it. The scheduler only ever calls `acquire` and `release`; how much server lifecycle that implies is the adapter's business.

For a multi-model runtime the two layers are distinct — `release` unloads a model and the server keeps running. For a single-model runtime they collapse: `release` is `stop`.

The scheduler never calls `release` for an entry marked `keep_resident`, except on shutdown ([§8](03-lifecycle.md#lifecycle)). An adapter does not need to know that; what it does need is `keepLoaded`, which `acquire` and `verifyIdentity` both take. A multi-model adapter enforces residency by unloading whatever it did not load, and that is precisely the code that would unload a kept model. `keepLoaded` is the allowlist, expressed in the ids _this_ runtime answers to — LM Studio's gateway-assigned `--identifier`, oMLX's backend model name, or Ollama's tag-qualified model name — which is why core filters it by runtime before handing it over. Ollama normalizes an omitted tag to `:latest` for these comparisons.

Never leave `stop` ambiguous between "terminate the process" and "free the memory". `stop` is always about the server.

There is deliberately no `restart`. Every restart in this design is a `release` followed by an `acquire`, driven by the scheduler; an adapter-level restart would be a second path into the same transition, able to bypass draining and the slot.

---

## MTPLX Adapter

Official adapter: `@llm-runtime-dock/adapter-mtplx`.

Upstream: [MTPLX](https://mtplx.com) · [source](https://github.com/youssofal/MTPLX).

Model release: `stop_server` — MTPLX serves one model per process, so freeing the resident slot means stopping the server ([§8](03-lifecycle.md#lifecycle)).

Responsibilities:

- translate the model entry into an MTPLX CLI invocation;
- start and stop through supported CLI/process mechanisms;
- perform health/readiness checks through HTTP;
- query `/v1/models`;
- expose endpoint;
- report capabilities where known.

#### Lifecycle commands

```text
start:   mtplx serve --model <backend_model> --host <host> --port <port> [mapped options] [extra_args]
stop:    mtplx stop --port <port>          (this is also `release`)
status:  mtplx status --json
models:  mtplx models
```

Surfaces: OpenAI and Anthropic. MTPLX serves `/v1/messages` and `/v1/messages/count_tokens` alongside chat completions ([§14](06-gateway-api.md#gateway-api)).

#### Curated options

Each named option maps to exactly one documented `mtplx serve` flag:

| option             | flag                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `reasoning`        | `--reasoning {auto,on,off}`                                                |
| `reasoning_effort` | `--reasoning-effort {auto,low,medium,high,xhigh}`                          |
| `profile`          | `--profile {stable,performance-cold,sustained,turbo,exact,max-diagnostic}` |
| `depth`            | `--depth`                                                                  |
| `generation_mode`  | `--generation-mode {mtp,ar,auto}`                                          |
| `context_window`   | `--context-window`                                                         |
| `max_tokens`       | `--max-tokens`                                                             |
| `batching_preset`  | `--batching-preset {solo,latency,agent,throughput}`                        |
| `scheduler_mode`   | `--scheduler-mode`                                                         |

And the group that decides how MTPLX renders tools, reasoning and the chat template — the settings that determine whether a coding agent's tool calls come back as `tool_calls` or as text the agent cannot parse:

| option                  | flag                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `tool_prompt_mode`      | `--tool-prompt-mode {hybrid,native}`                                             |
| `chat_template_profile` | `--chat-template-profile {local_qwen36,froggeric_v19,froggeric_v21_3,tokenizer}` |
| `chat_template_path`    | `--chat-template-path` (a `~/` or `~\` path is expanded at launch)               |
| `reasoning_parser`      | `--reasoning-parser {qwen3,step3p5,gemma4,poolside_v1,none}`                     |
| `preserve_thinking`     | `--preserve-thinking {auto,on,off,scoped}`                                       |
| `agent_rewrites`        | `--agent-rewrites {on,off}`                                                      |
| `stats_footer`          | `false` renders `--no-stats-footer`                                              |
| `stream_interval`       | `--stream-interval`                                                              |
| `defaults`              | none — `false` opts out of the launch defaults below                             |

MTPLX exposes many more flags. They are reachable through `extra_args` and are deliberately not enumerated here — this list is the supported, validated surface.

Reserved ([§12](05-configuration.md#configuration)): `--host`, `--port`, `--model`, `--model-id`, `--api-key`, `--api-key-file`.

#### Launch defaults, and the rule that keeps the table short

The dock fills in a small number of flags an entry did not set. An explicit `options:` key always wins, and `defaults: false` drops the table entirely.

| default        | value   | why                                                                                                                                       |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `stats_footer` | `false` | MTPLX otherwise appends a visible TPS footer to the _text_ of every response. A coding agent reads that as part of the assistant message. |

That is the whole table, and the rule is why:

> **A default may only be model-independent.**

The table is written without knowing which `backend_model` an entry names. Anything whose correct value follows from the weights, the chat template or the trained contract — `--tool-prompt-mode`, `--chat-template-profile`, `--reasoning-parser`, `--preserve-thinking`, `--profile`, `--depth`, `--context-window` — must stay with MTPLX's own per-model resolution, which can see the model while this table cannot. `--no-stats-footer` qualifies because the footer is MTPLX-generated text appended to any model's output.

The rule has one consequence worth stating plainly, because it is the question people arrive with: **there are no tool-calling defaults.** Every MTPLX flag that governs tool rendering is model-dependent, so all of them are configurable per entry and none is set for you. Two are worth knowing about when tool calls come back as text:

- `tool_prompt_mode: native` renders tools from the model's own chat template only. Note that MTPLX overrides the launch value to an internal `compact` mode when it detects OpenCode, so this is a per-model experiment rather than a switch that always applies.
- `agent_rewrites: off` is MTPLX's documented hard-passthrough guarantee — it stops transcript compaction, injected steering contracts and heuristic toolset filtering. It is deliberately **not** defaulted: MTPLX's own default is the setting known to work, and moving away from it while diagnosing a fault would add a variable rather than remove one.

Options are launch configuration, never request rewriting ([§12](05-configuration.md#configuration)): none of this is derived from an HTTP request, and changing any of it means restarting the runtime.

#### Attach or spawn

If a healthy MTPLX server already answers on the configured port, attach to it and verify ([§17](03-lifecycle.md#model-identity-verification)) that it serves this entry's `backend_model`. If it serves a different model, it is holding the resident slot and must be released — `mtplx stop --port <port>` — before starting the right one, even if the gateway did not start it.

#### Auth

MTPLX requires an API key only for non-localhost binds. The adapter must not add `--api-key`, `--api-key-file` or `--no-auth` by itself. Upstream credentials follow [§12](05-configuration.md#configuration).

Do not put scheduler logic into this adapter.

The adapter should not know anything about OpenCode.

---

## LM Studio Adapter

Official adapter: `@llm-runtime-dock/adapter-lm-studio`.

Upstream: [LM Studio](https://lmstudio.ai) · [`lms` CLI docs](https://lmstudio.ai/docs/cli) · [source](https://github.com/lmstudio-ai/lms).

Model release: `unload_model` — `lms unload` frees the model and the server keeps running ([§8](03-lifecycle.md#lifecycle)).

LM Studio's CLI separates server lifecycle from model lifecycle: `lms server start` runs one shared server, and models are loaded into and unloaded from it. The adapter must respect that split.

#### Lifecycle commands

```text
check:  lms server status --json
start:  lms server start --port <port>            (only if no server is running)
        lms load <backend_model> --identifier <model id> [mapped options] [extra_args] --yes
stop:   lms unload <model id>                     (the server stays up)
ready:  lms ps --json
```

`lms server stop` must not be used during a normal model switch: the gateway does not exclusively own that server.

`lms server start --port` only decides the port when no server is running; otherwise LM Studio reuses the port from its last start. So the adapter must check `lms server status --json` first:

- no server running → spawn one on the configured port;
- server running on the configured port → attach to it;
- server running on a different port → fail with an actionable error, naming both ports.

Never assume the configured port. A silently mismatched port would proxy to the wrong server or to nothing, which is the failure mode [§17](03-lifecycle.md#model-identity-verification) exists to prevent.

Releasing the slot is `lms unload <model id>`. `lms server stop` is not part of any switch.

Surfaces: OpenAI and Anthropic.

#### Curated options

| option           | flag                   |
| ---------------- | ---------------------- |
| `gpu`            | `--gpu {off,max,0..1}` |
| `context_length` | `-c, --context-length` |
| `parallel`       | `--parallel`           |

Reserved ([§12](05-configuration.md#configuration)): `--identifier`, `--ttl`, `-p/--port`, `--bind`.

`--ttl` is reserved because an idle auto-unload would drop the model behind the gateway's back, leaving the tracked state wrong.

Lifecycle must remain CLI/process based.

Do not automate the LM Studio GUI.

If a requested lifecycle operation cannot be performed through supported CLI/process mechanisms, report the limitation explicitly instead of implementing GUI automation or undocumented API calls.

HTTP may be used for readiness, model discovery and inference.

---

## oMLX Adapter

Official adapter: `@llm-runtime-dock/adapter-omlx`.

Upstream: [oMLX](https://omlx.ai) · [source](https://github.com/jundot/omlx).

Model release: `unload_model` ([§8](03-lifecycle.md#lifecycle)).

oMLX is a multi-model OpenAI-compatible server for Apple Silicon. One server process discovers every model under its model directory and loads them into memory on demand, with LRU eviction.

Two consequences shape this adapter:

1. Its CLI manages the **server** only. There is no `omlx load` or `omlx unload`. Model residency is exposed exclusively through documented, authenticated HTTP endpoints, so HTTP is the correct lifecycle mechanism here ([§10](03-lifecycle.md#process--cli-lifecycle)).
2. It loads models **by itself** when a request arrives for one that is not resident. The gateway must therefore drive residency explicitly rather than let a proxied request decide it.

#### Lifecycle

```text
probe:     GET  /health                       (no auth required)
spawn:     omlx serve --host <host> --port <port> [server options]
acquire:   POST /v1/models/<backend_model>/load
release:   POST /v1/models/<backend_model>/unload
residency: GET  /v1/models/status      (models[], loaded_count)
discovery: GET  /v1/models             (data[], max_model_len)
```

If a healthy server already answers on the configured endpoint, attach to it and never spawn a second one — a second server would duplicate model memory and fight the first one's memory guard.

`omlx start` / `omlx stop` / `omlx restart` drive the macOS application's background server, which takes its host and port from oMLX's own settings rather than from arguments. Prefer `omlx serve` when spawning, because it accepts `--host` and `--port` and the gateway must own its endpoint.

The gateway never stops an oMLX server as part of a switch. Unloading is enough, and the server is normally the user's.

#### Loading is the readiness primitive

`POST /v1/models/{id}/load` blocks until loading completes. Use it instead of polling: when it returns, the model is resident.

It answers `404` for an unknown model — a discovery error, distinct from a load failure — and `unload` answers `400` when the model was not loaded, which is a benign no-op during release.

#### Enforcing one resident model

Because oMLX auto-loads on request and evicts by LRU, it can hold several models. That would break the invariant of [§8](03-lifecycle.md#lifecycle) quietly, so before marking ready the adapter must:

1. load the target explicitly;
2. read `GET /v1/models/status`, whose per-model array is `models` (`data` is the discovery endpoint's key, and reading it here finds nothing);
3. confirm the target has `loaded: true`;
4. confirm nothing else is resident beyond `keepLoaded`, unloading any stray;
5. only then report `ready`.

Step 4 is the one place `keep_resident` reaches into this adapter. `loaded_count == 1` was the original rule and is still what happens when nothing is kept; with a kept entry on the same server the rule is that the resident set is a subset of the target plus `keepLoaded`. The same comparison is made twice on purpose — once in `acquire`, once in `verifyIdentity` — because oMLX can load a model on its own between the two.

A model marked `pinned` in that response cannot be evicted. If a pinned model occupies the slot, fail with `RUNTIME_MODEL_PINNED` and say which model and how to unpin it. Never proceed leaving a model resident by accident. A pinned model that is _in_ `keepLoaded` is not an accident — oMLX's own pin and the configuration agree — so it passes. `doctor` reports pinned models as a warning before they cause a failed switch, and skips the entry's own model when it is kept.

#### Options

In attach mode there are no per-entry options. `backend_model` is the model id oMLX discovered — the name of its directory under the model directory — and everything else about how that model runs lives in oMLX's own configuration.

Spawn-mode options are server-scoped, not per-model ([§12](05-configuration.md#configuration)):

| option                    | flag                                            |
| ------------------------- | ----------------------------------------------- |
| `model_dir`               | `--model-dir`                                   |
| `memory_guard`            | `--memory-guard {off,safe,balanced,aggressive}` |
| `max_concurrent_requests` | `--max-concurrent-requests`                     |

Entries sharing an endpoint must agree on them, and they are ignored when attaching.

Reserved ([§12](05-configuration.md#configuration)): `--host`, `--port`, `--api-key`.

#### Auth

oMLX accepts a Bearer token or an `x-api-key` header, and serves openly when no key is configured. `/health` never requires one.

Its key lives in oMLX's own settings file. The gateway must not read that file ([§10](03-lifecycle.md#process--cli-lifecycle)). Supply the credential through the declared runtime's `auth` block ([§12](05-configuration.md#configuration)) instead.

#### Out of scope

Surfaces: OpenAI and Anthropic. oMLX serves `/v1/messages` and `/v1/messages/count_tokens`, which the gateway proxies ([§14](06-gateway-api.md#gateway-api)).

It also serves `/v1/embeddings`, `/v1/rerank`, `/v1/audio/*`, `/v1/responses` and MCP integration. Those stay out of scope ([§30](01-overview.md#non-goals)) — the gateway proxies chat completions and messages, nothing more.

---

## Ollama Adapter

Official adapter: `@llm-runtime-dock/adapter-ollama`.

Upstream: [Ollama](https://ollama.com) · [source](https://github.com/ollama/ollama).

Model release: `unload_model` ([§8](03-lifecycle.md#lifecycle)). Ollama is a
multi-model server and the adapter explicitly keeps only the requested model and
configured `keepLoaded` models resident.

#### Lifecycle

```text
probe:     GET  /api/version, /api/ps, /api/tags
spawn:     ollama serve                       (environment-configured)
acquire:   POST /api/generate {keep_alive:-1}
release:   POST /api/generate {keep_alive:0}
residency: GET  /api/ps
discovery: GET  /api/tags
```

`ollama serve` is foreground, so `lrd probe --start` is intentionally not
available. A healthy endpoint is attached rather than spawning a second server.
The model load call is blocking and is therefore the readiness primitive.

Unlike the other adapters, `probe` asks over HTTP first and only consults the
executable once nothing answered. Ollama's whole lifecycle is HTTP — load,
unload, `ps`, `tags` — and `ollama` is needed for `serve` alone, so a remote or
containerized server is fully drivable without it. `not_installed` is reserved
for the case where nothing answers _and_ nothing could be started;
`lrd doctor` is what reports a missing executable on a server that is up.

#### Options

All options are server-scoped environment variables:

| option              | environment variable       |
| ------------------- | -------------------------- |
| `model_dir`         | `OLLAMA_MODELS`            |
| `context_length`    | `OLLAMA_CONTEXT_LENGTH`    |
| `max_loaded_models` | `OLLAMA_MAX_LOADED_MODELS` |
| `num_parallel`      | `OLLAMA_NUM_PARALLEL`      |
| `flash_attention`   | `OLLAMA_FLASH_ATTENTION`   |
| `kv_cache_type`     | `OLLAMA_KV_CACHE_TYPE`     |

`OLLAMA_HOST` and `OLLAMA_KEEP_ALIVE` are reserved by the gateway. Use the
runtime's `host`/`port` and the model's `keep_resident` instead. A kept model
requires `max_loaded_models: 2` or greater when that option is set, because
Ollama would otherwise evict the kept model to stay under the limit.

`extra_args` is refused for this adapter, at config load time: `ollama serve`
accepts no flags at all, so anything placed there would reach it as an operand
and stop it from starting. Everything Ollama documents is an environment
variable, and the curated `options:` above are how the gateway sets them.

#### Auth

Ollama itself has no credential mechanism. An `auth` block is still forwarded as
a Bearer header for Ollama-compatible installations behind an authenticated
proxy.

#### Out of scope

Ollama serves the OpenAI surface only; it cannot fill an Anthropic role through
`lrd apply`. `/api/generate` does not load embedding-only models. The adapter
does not classify that capability from `/api/tags`, so such models may appear in
discovery and should be left out of the gateway configuration (or marked
`disabled: true`).

---

## Custom Adapter

The custom adapter is a first-class feature.

It allows a user to define an unsupported runtime without writing code.

Example:

Everything it declares describes the _server_, so it all lives on the declared
runtime ([§12](05-configuration.md#configuration)); the model entry names it and
adds only the reference that runtime understands.

```yaml
runtimes:
  legacy:
    adapter: custom

    process:
      start:
        command:
          - some-runtime
          - serve
          - --model
          - some-model-7b
          - --port
          - '8000'

      stop:
        command:
          - some-runtime
          - stop

      cwd: /Users/me/models

      env:
        SOME_RUNTIME_LOG_LEVEL: info

      startup_timeout_ms: 120000
      shutdown_timeout_ms: 15000

    health:
      url: http://127.0.0.1:8000/health
      timeout_ms: 5000

    model_discovery:
      url: http://127.0.0.1:8000/v1/models

    endpoint:
      url: http://127.0.0.1:8000/v1

models:
  legacy-runtime:
    runtime: legacy
    backend_model: some-model-7b
```

Prefer argv arrays over shell strings.

For example:

```yaml
command:
  - some-runtime
  - serve
  - --model
  - some-model-7b
```

is preferred over:

```yaml
command: 'some-runtime serve --model some-model-7b'
```

If shell execution is supported, it must be explicitly enabled in configuration.

The custom adapter probes `endpoint.url` to decide between attaching and spawning ([§8](03-lifecycle.md#lifecycle)), since it has no `port` field of its own. Model release is `stop_server`: the configured stop command.

It declares the OpenAI surface only. Nothing about a user-defined command implies an Anthropic endpoint, so serving one is an explicit opt-in on the declared runtime:

```yaml
runtimes:
  legacy:
    surfaces: [openai, anthropic]
```

Without it, a model on a custom runtime cannot fill an Anthropic role ([§23](08-agents.md#agent-integrations)).

The custom adapter is the one case where the user owns the whole argv, so the reserved-argument rules of [§12](05-configuration.md#configuration) do not apply to `process.start.command`. In exchange, the command and the declared `health` / `model_discovery` / `endpoint` URLs must agree; `doctor` checks that they do.

CRITICAL SECURITY RULE:

> Never interpolate values originating from an HTTP request into lifecycle commands.

Lifecycle commands are trusted configuration only.
