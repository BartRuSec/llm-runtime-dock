# Lifecycle and scheduling

The resident slot, the runtime state machine, how a switch is serialized and
drained, and what has to be true before a runtime is called ready.

---

## Lifecycle

Runtime state machine:

```text
                 ┌──────────┐
                 │ stopped  │
                 └────┬─────┘
                      │ start
                      ▼
                 ┌──────────┐
                 │ starting │
                 └────┬─────┘
                      ▼
                 ┌──────────┐
                 │ loading  │
                 └────┬─────┘
                      ▼
                 ┌──────────┐
                 │  ready   │
                 └────┬─────┘
                      │ switch/stop
                      ▼
                 ┌──────────┐
                 │ draining │
                 └────┬─────┘
                      ▼
                 ┌──────────┐
                 │ stopping │
                 └────┬─────┘
                      ▼
                 ┌──────────┐
                 │ stopped  │
                 └──────────┘

Any state can transition to:

                 ┌──────────┐
                 │  failed  │
                 └──────────┘
```

Rules:

- Never kill an active request during a normal model switch.
- Streaming requests count as active until their stream closes or is cancelled.
- New requests for the target runtime may queue while switching.
- New requests for a different model/runtime must not start another runtime concurrently.
- Same-runtime concurrency is allowed when the runtime supports it.
- Equal-priority requests use FIFO ordering.

The states describe one entry's grip on the resident slot, not necessarily a process. `stopping` means releasing the slot; for a multi-model runtime that is an unload and the server stays up.

#### The resident slot

**At most one model is resident in memory at any time, across every adapter, unless an entry explicitly opts out with `keep_resident`.**

The default is a hard invariant, not a policy someone tunes by accident: a single Mac has one memory pool, and two resident models mean paging or OOM ([§29](#memory--resource-policy)).

Core owns one **resident slot**. The scheduler is the only thing that may fill or free it, through the adapter's `acquire` / `release` ([§7](04-adapters.md#runtime-adapter-interface)).

Because the slot is global, switching is routinely **cross-adapter**: releasing an oMLX model to start MTPLX, then stopping MTPLX to load an oMLX model again.

#### Two things, not one: the loaded set and the serving token

`keep_resident` splits what would otherwise be a single idea:

- the **loaded set** is memory. It holds one _rotating_ occupant — the slot — plus any entry configured with `keep_resident: true`.
- the **serving token** is who answers. Exactly one entry at a time, always, granted by the scheduler's one FIFO pump.

A kept entry is never released by a switch. Neither is the rotating occupant when the serving token moves to or from a kept entry: **both halves are required.** Keeping a small model loaded while every trip to it still evicted the large model would be worse than not having the flag, because the large model would reload each time.

So `keep_resident` buys **memory residency, not concurrency**. The models sit in memory together; they still take turns answering, because the GPU they share cannot be split without both of them getting slower.

Which entries can be kept is decided at config load ([§12](05-configuration.md#configuration)), not at switch time. A `stop_server` runtime serves one model per server, so a kept entry there must own its runtime outright — an entry sharing that server could only be started by stopping it, which is exactly what the flag forbids. The check names the conflict and tells the user to declare a second runtime on its own port.

The `models:` entry itself is one key:

```yaml
runtimes:
  mtplx-resident: { adapter: mtplx, port: 8001 }

models:
  summariser:
    runtime: mtplx-resident
    backend_model: Youssofal/Qwen3.5-4B-MTPLX-Optimized-Quality
    keep_resident: true
```

Shutdown is the one place the flag stops applying: everything loaded is released, kept entries included, because nothing would be left to free the memory afterwards. A kept entry's lifetime is the gateway's, which is why the shutdown path's wait for in-flight requests is bounded rather than open-ended ([§27](10-cli.md#cli)) — a held stream must not be able to strand a model in memory.

#### Server ownership is decided at runtime

Ownership is not declared in configuration. Before acquiring the slot, the adapter probes the configured endpoint:

- a healthy server answers → **attach** to it;
- nothing answers → **spawn** a server and own it.

The decision procedure is the same for every adapter. What counts as "the configured endpoint", and what a partial match means, is not: mtplx, omlx and ollama derive it from `host`/`port`, custom declares it as `endpoint.url`, and LM Studio's port is sticky from its last start, so a server answering on a _different_ port is an error rather than an invitation to spawn ([§19](04-adapters.md#lm-studio-adapter)).

#### Model release

How the slot is freed depends on the runtime, so each adapter declares `modelRelease`:

| adapter   | `modelRelease` | freeing the slot                                                 |
| --------- | -------------- | ---------------------------------------------------------------- |
| omlx      | `unload_model` | `POST /v1/models/{id}/unload` — server keeps running             |
| ollama    | `unload_model` | `POST /api/generate {keep_alive: 0}` — server keeps running      |
| lm-studio | `unload_model` | `lms unload <identifier>` — server keeps running                 |
| mtplx     | `stop_server`  | `mtplx stop --port <port>` — single-model server, no other lever |
| custom    | `stop_server`  | the configured stop command                                      |

For `unload_model` adapters the server survives, so other clients are unaffected. Such a server can hold a kept entry alongside the rotating one, which is why the adapter is told what to leave alone: `acquire` and `verifyIdentity` both take a `keepLoaded` list, and an adapter that enforces residency by unloading strays would otherwise undo the flag through the very mechanism meant to police it ([§7](04-adapters.md#runtime-adapter-interface)).

For `stop_server` adapters there is no way to free memory without stopping the server. The gateway therefore stops it **whether it spawned it or attached to it**, and logs that explicitly:

```text
releasing foreign mtplx server on :8000 to free the resident slot
```

The one-resident invariant outranks leaving a foreign single-model server alone. This is deliberate: without it the gateway cannot guarantee the memory state it exists to manage.

A `keep_resident` entry is the exception, and only where it owns its runtime: its server is never stopped by a switch, because nothing else has any reason to stop it.

---

## Runtime Switching

When a request arrives:

```text
request
  │
  ▼
resolve model id
  │
  ├── this entry holds the slot + model identity matches
  │       │
  │       └──> proxy immediately
  │
  └── otherwise
          │
          ▼
       enqueue
          │
          ▼
       drain active requests
          │
          ▼
       release the current slot occupant
       (unload_model or stop_server, per its adapter)
          │
          ▼
       acquire the slot for this entry
          │
          ▼
       attach to a running server, or spawn one
          │
          ▼
       load the model
          │
          ▼
       wait for health/readiness
          │
          ▼
       verify model identity and residency
          │
          ▼
       forward queued request
```

The occupant being released and the entry acquiring the slot may belong to **different adapters**. Cross-adapter switching is the normal case, not an edge case.

Switching must be serialized.

Two simultaneous requests must not trigger two independent acquire/release cycles.

#### What counts as "the same runtime"

The scheduler compares **entry ids**, not backend model names.

Two entries may serve the same `backend_model` with different launch options. They are different runtime instances, and moving between them is a full stop/start cycle even though model identity verification would return the same model name.

Model identity verification ([§17](#model-identity-verification)) answers "did the runtime load what this entry asked for". It never answers "is a restart needed".

---

## Process / CLI Lifecycle

This is a hard architectural requirement.

Runtime lifecycle must be controlled through:

- documented CLI commands
- normal OS process control
- signals
- configured executable paths
- configured working directories
- configured environment variables

Do NOT use:

- GUI automation
- accessibility automation
- private APIs
- undocumented runtime internals
- direct modification of runtime databases/state
- reverse-engineered IPC
- HTTP endpoints as a substitute for lifecycle commands when the runtime documents CLI/process control

HTTP is appropriate for:

- `/health`
- `/v1/models`
- inference
- streaming
- documented readiness/status endpoints
- documented lifecycle operations that the runtime's CLI does not expose at all

#### When HTTP _is_ the lifecycle mechanism

The rule above forbids reaching for HTTP as a **substitute** for a documented CLI operation. It does not forbid using a documented HTTP endpoint for an operation the CLI never offers.

oMLX is the concrete case: `omlx start` / `stop` / `restart` / `serve` manage the _server_, and there is no CLI command to load or unload an individual model. Model residency is exposed only through documented, authenticated HTTP endpoints. Using them is correct; there is nothing to substitute for.

The test is not "is it HTTP" but "is the runtime documenting this operation, and is there a CLI path being bypassed".

Reading or writing a runtime's own configuration or state files is never acceptable, regardless of what it would make possible.

---

## Health and Readiness

Distinguish:

#### Gateway health

Whether `llm-runtime-dock` itself is alive.

```http
GET /health
```

#### Runtime readiness

Whether the selected backend:

1. a server answers on the configured endpoint (attached or spawned, [§8](#lifecycle)),
2. health endpoint reports ready,
3. inference endpoint is reachable,
4. expected model identity is present,
5. the model is actually resident, and nothing else is — beyond the entries `keep_resident` puts there on purpose ([§8](#lifecycle)).

Do not mark a runtime ready merely because its process started, or merely because a server responded.

#### Health can mean "not yet"

A bound port is not readiness, and neither is an answered health request. A runtime may bind its port and serve `/health` while still loading.

oMLX does exactly this: `/health` answers `503` with status `loading` during startup preload, deliberately, so that watchdogs see liveness without seeing readiness.

Treat that as the `loading` state — not `ready`, and not `failed`. Only a timeout turns it into a failure.

#### Residency check

Step 5 is what enforces the resident-slot invariant ([§8](#lifecycle)) against runtimes that load models on their own.

For multi-model runtimes, verify through the runtime's own status endpoint that the expected model is loaded **and** that nothing else is, except what `keepLoaded` names. oMLX exposes this as `loaded` per model plus `loaded_count` in `GET /v1/models/status`, whose array is named `models` — not `data`, which is `/v1/models`' OpenAI-shaped key.

If other models are resident, release them before marking ready. A model in `keepLoaded` is not "other": another entry is keeping it, and unloading it would break [§8](#lifecycle) from the opposite direction.

For `stop_server` runtimes ([§8](#lifecycle)) there is nothing extra to query: one server serves one model, so steps 1 and 4 together already establish residency. Do not invent a residency endpoint for them.

---

## Model Identity Verification

After startup:

1. wait for health;
2. query configured `/v1/models`;
3. inspect returned model IDs;
4. verify that the expected model is present;
5. only then mark runtime `ready`.

Where the identity comes from:

| adapter   | source of truth                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| mtplx     | `/v1/models`; the served id defaults to the loaded artifact identity, and `--model-id` is reserved so it cannot drift |
| lm-studio | `lms ps --json`, matched against the gateway-assigned `--identifier`                                                  |
| omlx      | `/v1/models` for discovery, `/v1/models/status` for residency (`loaded`, `loaded_count`)                              |
| ollama    | `/api/tags` for discovery, `/api/ps` for residency                                                                    |
| custom    | the configured `model_discovery.url` endpoint                                                                         |

If the wrong model is returned:

```text
runtime starts
   ↓
health OK
   ↓
models endpoint
   ↓
expected model missing
   ↓
FAILED
```

Never silently proxy a request to a different model than requested.

---

## Scheduler

Minimal scheduler requirements:

- ownership of the resident slot ([§8](#lifecycle));
- serialized runtime switching;
- request queue;
- active request tracking;
- streaming request tracking;
- graceful draining;
- FIFO ordering for equal priority;
- cancellation;
- no duplicate starts/stops;
- deduplication of concurrent requests targeting the same entry id during startup;
- release of the current occupant before acquiring the slot, including across adapters;
- one serving token, moved between loaded entries without loading or releasing anything;
- kept entries excluded from release on every path but shutdown ([§8](#lifecycle)).

Example:

```text
request A → coding-quality   (mtplx)
request B → coding-quality   (mtplx)
request C → omlx-coder       (omlx)

A acquires the slot for coding-quality
B joins the coding-quality queue
C waits

A finishes
B runs

B finishes
coding-quality drains
  → release: mtplx stop --port 8000
  → slot free
omlx-coder acquires the slot
  → attach to oMLX on :5678 (or spawn it)
  → POST /v1/models/<model>/load
  → verify loaded_count == 1
C runs
```

If A and B target the same ready entry, do not release or reacquire anything.

If they target different entries that happen to share a `backend_model`, a restart is still required: their launch flags differ.

The release step uses the _current occupant's_ adapter, and the acquire step uses the _target's_. Neither knows about the other.

#### A shared server is not a shared slot

`omlx-coder` and `omlx-small` point at the same oMLX server. When one holds the slot and a request arrives for the other, the server being already up and healthy changes nothing: the transition is still a full release then acquire — an unload followed by a load — because both cannot be resident at once.

Skipping the transition because "the server is already running" is the single easiest way to break [§8](#lifecycle), and it would leave two models in memory while every health and identity check still passed.

`keep_resident` is the one way to ask for that second resident model deliberately, and it is a config decision rather than something the scheduler infers from the server being up. When `omlx-small` carries the flag, the transition really is only a handover: nothing is unloaded and nothing is loaded, because both models are already there. The distinction that matters is not "is the server shared" but "did configuration say to keep this one".

---

## Observability

Required:

- structured logs;
- request ID;
- runtime switch events;
- startup duration;
- readiness duration;
- upstream latency;
- errors;
- resident slot occupant, the entries kept alongside it, which one holds the serving token, and how the previous occupant was released;
- whether the server was attached or spawned;
- queue depth.

If the upstream exposes token metrics, optionally record:

- TTFT
- tokens/sec
- total tokens

Do not introduce a telemetry platform.

---

## Memory / Resource Policy

There is no GPU memory management, by design.

The memory policy is the resident slot ([§8](#lifecycle)): one model in memory at a time, released explicitly before the next is acquired. That is the default, and nothing infers its way out of it.

`keep_resident` is the one documented way out, and it moves the budget to the user rather than adding a policy engine. An entry carrying it stays loaded, so the machine holds that model plus whichever one is rotating; the gateway does not measure, predict or reclaim the difference. It cannot — it does not know how large a model is until the runtime has loaded it, and by then the memory is already spent.

What the gateway does instead is make the cost visible: `lrd status` lists the kept entries next to the occupant, and `doctor` warns when more than one entry is kept.

Future optional policy may include:

```yaml
resources:
  max_resident_memory_gb: 48
  reserve_memory_gb: 8
```

This must be a policy layer, not tightly coupled to individual adapters.

The implementation relies on explicit lifecycle switching, and nothing else.
