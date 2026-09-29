# Overview

What `llm-runtime-dock` is, the principles it holds to, the vocabulary the
rest of these documents use, and the boundaries of the project.

---

## Purpose

`llm-runtime-dock` is a lightweight local LLM gateway and runtime lifecycle manager.

Its job is to give coding agents such as OpenCode, Claude Code and Codex one stable local endpoint while transparently managing which local LLM runtime/model is active behind it, and to write itself into those agents' configuration so they can find it.

The project is intentionally small. It is a gateway/orchestrator, not an inference engine.

#### Core idea

```text
OpenCode · Claude Code · Codex
        │
        │ OpenAI or Anthropic API
        ▼
┌─────────────────────────┐
│    llm-runtime-dock      │
│                         │
│ model resolution        │
│ resident slot           │
│ runtime scheduling      │
│ lifecycle management    │
│ health/readiness        │
│ request proxy           │
│ agent config apply      │
└────────────┬────────────┘
             │
  CLI / process control, plus
  documented HTTP lifecycle
             │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
 MTPLX   LM Studio   oMLX   Ollama
   │         │         │
   └─────── HTTP ──────┘
    health/models/inference
```

The gateway must never need to know how inference itself works.

---

## Design Principles

1. **Small core.**
2. **Runtime lifecycle is controlled only through documented CLI/process commands.**
3. **HTTP is used for health, readiness, model discovery and inference.**
4. **Adapters are plugins.**
5. **Unsupported runtimes can be integrated through a declarative custom adapter without writing TypeScript.**
6. **The external interface is OpenAI-compatible, with an Anthropic-compatible surface alongside it.**
7. **Logical model IDs are the user-facing abstraction; one config entry is one runtime instance.**
8. **No GUI automation or undocumented/private runtime APIs.**
9. **No request-derived shell execution.**
10. **Default operation is local-only and binds to `127.0.0.1`.**
11. **The gateway should be usable without a database or UI.**
12. **Avoid premature abstraction: package boundaries must earn their existence.**
13. **Runtime-specific launch options belong to adapters, not to core.**
14. **At most one model is resident in memory at a time, across every backend.**

---

## Terminology

#### Model

Logical model identity, e.g.

```text
qwen38
qwen36
```

A model is not necessarily tied to one runtime.

#### Runtime

A serving implementation/backend, e.g.

```text
mtplx
lm-studio
omlx
ollama
custom
```

#### Declared runtime

One entry in the `runtimes:` map ([§12](05-configuration.md#configuration)): an
adapter plus an endpoint, and the server-scoped options and credential that go
with it. Several models may name one.

```text
id:       mtplx
adapter:  mtplx
endpoint: http://127.0.0.1:8000
```

A declared runtime with no models on it is legal — it is the first thing
`lrd probe --save` writes ([§22](07-discovery.md#runtime-discovery)).

#### Runtime instance

A concrete, fully specified way of serving one model: a model paired with the
declared runtime that serves it, which supplies the adapter and the endpoint.

Example:

```text
id:            coding-quality
runtime:       mtplx          (adapter mtplx at http://127.0.0.1:8000)
backend model: Qwen3.8-27B
options:       reasoning_effort=high, profile=turbo
```

A runtime instance is what a client selects. Its id is the logical model name exposed through `/v1/models`.

There is no separate profile entity. Two entries may serve the same backend model with different launch options; because those options are start-time CLI flags, each variant is its own runtime instance, and switching between them restarts the process.

Several models may name one declared runtime when the server serves many (oMLX, LM Studio, Ollama). The server is shared; residency is not. Only one of them holds the resident slot at a time ([§8](03-lifecycle.md#lifecycle)).

---

## Security

Default:

```text
host: 127.0.0.1
```

No authentication is required for a loopback bind unless `server.auth` is set, or the `LRD_API_KEY` environment variable happens to be, out of the box.

The gateway can require an API key of its own clients (`server.auth`, [§12](05-configuration.md#configuration), enforced in [§14](06-gateway-api.md#gateway-api)) — a separate concern from the per-runtime `auth:` block, which is a credential LRD sends _upstream_. When a key is configured it is required on every route except `/health`, including `/v1/models` and the lifecycle controls. It does not replace the rule below: a valid key never lifts the loopback-only restriction on `/status`/`/switch`, since a leaked key must not hand out remote process control on top of remote inference.

`/status` and `/switch` ([§14](06-gateway-api.md#gateway-api)) are lifecycle controls. They bind to loopback only, and are refused outright when the gateway is bound to a non-loopback address, whether or not an API key is configured.

Applying configuration to a coding agent writes into files the user owns. It merges rather than replaces, backs up first, and never writes a credential value except where the format has no alternative — an agent whose configuration format can only hold a literal string (Claude Code's `settings.json`) receives the gateway's own resolved key that way, since the whole reason the key exists is for that agent to present it back; every format that can reference a value by environment variable does that instead ([§23](08-agents.md#agent-integrations)).

Discovery writes configuration from data a server returned over HTTP. That is permitted at configuration time and only on an explicit flag, under the constraints in [§22](07-discovery.md#runtime-discovery). It is never permitted at request time.

Never:

- execute arbitrary commands supplied through HTTP;
- concatenate request values into shell commands;
- expose lifecycle controls publicly by default;
- serve `/status` or `/switch` on a non-loopback bind, API key or not;
- log secrets;
- put API keys/passwords into example configs;
- inline a resolved secret into a coding agent's configuration, except where the format has no way to reference one instead.

A non-loopback bind with no API key configured is a reported warning (`doctor`, and the `serve` startup banner), not a hard failure: an operator who deliberately runs the gateway open must not be blocked, but the gap must be impossible to miss.

---

## Non-Goals

Deliberately absent, and not planned:

- web UI
- database
- model downloader
- model conversion
- quantization
- inference engine
- RAG
- MCP
- cloud routing
- billing
- user accounts
- remote multi-user auth
- automatic model discovery from the internet
- GPU memory optimizer
- GUI automation
- private/undocumented runtime APIs
- proxying anything beyond chat completions and Anthropic messages, even when a backend offers it (embeddings, rerank, audio, response APIs, MCP)
- translating between the OpenAI and Anthropic protocols: both are proxied to runtimes that already serve them

---

## Future Roadmap

Possible future features:

1. variants sharing one runtime process instead of restarting it;
2. hot reconfiguration where a runtime supports it (e.g. `mtplx settings set depth=2 reasoning=off`);
3. resident-runtime policies;
4. memory-aware eviction;
5. multiple simultaneous resident models, deliberately relaxing the one-resident invariant;
6. priority queues;
7. runtime auto-discovery;
8. npm plugin discovery;
9. richer metrics;
10. admin API;
11. optional authentication;
12. optional web UI.

None of these may complicate the core as it stands.

---

## Architectural Rule of Thumb

When deciding where code belongs:

```text
Is it about scheduling, switching, model resolution, the resident slot, lifecycle orchestration?
    → core

Is it about a specific runtime/backend, including its CLI flags?
    → adapter

Is it about a specific coding agent's configuration format?
    → agent plugin

Is it about HTTP?
    → gateway

Is it about command-line UX?
    → CLI

Is it generic configuration parsing/validation?
    → config layer

Can the feature be expressed as configuration instead of code?
    → prefer configuration
```

The project's success criterion is not the number of features.

It is:

> OpenCode talks to one stable local endpoint, while `llm-runtime-dock` reliably starts, stops, switches and proxies the correct local LLM runtime with minimal configuration.
