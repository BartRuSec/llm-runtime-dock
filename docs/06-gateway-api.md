# Gateway API

The HTTP surface: two client-facing protocols, both proxied rather than
translated, plus the two loopback-only lifecycle controls.

---

## Gateway API

Endpoints:

OpenAI surface:

```http
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

Anthropic surface, for clients that speak it — Claude Code among them:

```http
POST /v1/messages
POST /v1/messages/count_tokens
```

Plus two gateway-native endpoints, belonging to neither:

```http
GET  /status
POST /switch
```

Support:

- normal completions
- streaming via SSE
- tool calls
- standard OpenAI-style error responses
- request cancellation where possible
- request IDs
- upstream error propagation with normalized gateway errors
- verbatim passthrough of the client's `Authorization` header to the upstream runtime ([§12](05-configuration.md#configuration))

#### Two protocols, one gateway

The Anthropic surface is **routing, not translation**. MTPLX, LM Studio and oMLX each serve `/v1/messages` themselves, so the gateway resolves the model, ensures the runtime is resident, and proxies — exactly as it does for chat completions. Ollama is OpenAI-only.

Both surfaces share everything that matters: model resolution ([§13](05-configuration.md#model-resolution)), the resident slot ([§8](03-lifecycle.md#lifecycle)), the scheduler, draining, cancellation and identity verification. An Anthropic request names its model in the same `model` field, so nothing about resolution changes.

Streaming passes through unaltered. The gateway does not rewrite Anthropic SSE events into OpenAI chunks or the reverse; it never invents a protocol bridge.

A request on a surface the target runtime does not serve fails with `UPSTREAM_SURFACE_UNSUPPORTED`, naming the entry and the surface. Adapters declare which surfaces they serve through `capabilities()` ([§7](04-adapters.md#runtime-adapter-interface)), and `doctor` reports the gap before a client hits it.

`count_tokens` is proxied because Claude Code relies on it; a runtime that lacks it fails the same way.

#### Response headers

Responses are filtered by **denylist, not allowlist**: the hop-by-hop set plus `content-length` and `content-encoding` are dropped, and everything else passes through. A proxy that passes requests through should pass answers through too — an allowlist silently dropped `retry-after`, which agent clients back off on, along with `www-authenticate` and every rate-limit header, and it would drop each new upstream header the same way.

`content-length` and `content-encoding` are the two that genuinely cannot survive: the upstream body has already been decoded by the time it is re-emitted, so either header would describe bytes that are no longer the ones being sent.

The one rename: the upstream's `x-request-id` is forwarded as `x-upstream-request-id`, because the gateway stamps its own `x-request-id` and both are worth correlating.

#### `/status` and `/switch`

`GET /status` reports what the gateway is doing: whether it is running, which entry holds the resident slot, that entry's adapter, backend model, ownership and release mechanism, its state, and the queue depth. It is the source of truth for `lrd status` ([§27](10-cli.md#cli)).

`POST /switch` takes a logical model id and makes it resident.

It must go through the scheduler, exactly like a request-triggered switch ([§9](03-lifecycle.md#runtime-switching)): drain, release the occupant, acquire the slot. It is not a shortcut into the adapter. If a switch is already in flight for the same entry it joins that transition rather than starting a second one; for a different entry it queues behind it.

A request arriving mid-switch behaves as it always does — served if its entry ends up holding the slot, queued otherwise. `/switch` changes who wins the slot next, not the rules.

Both endpoints are lifecycle controls and bind to loopback only ([§28](01-overview.md#security)).

#### `--debug`: what was actually forwarded

`lrd serve --debug` writes one NDJSON file per serve session recording every proxied request and response. It is off by default and exists for one question: whether the gateway changed something between the client and the runtime. Answering that from the code is an argument; answering it from a capture is evidence.

What it records, one line per event:

| event      | carries                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`  | the upstream URL, the logical entry, the served id, the request headers, and the body **as sent upstream** — after `model` was resolved ([§13](05-configuration.md#model-resolution)) |
| `response` | the status, every header the upstream sent, and the subset that survives the response filter                                                                                          |
| `body`     | one chunk, tagged `upstream` (from the runtime) or `client` (what the pump wrote out)                                                                                                 |
| `end`      | `complete`, `cancelled` or `error`, with the duration                                                                                                                                 |

Reading one back:

```bash
# what actually reached the runtime
jq 'select(.event == "request") | .body | fromjson' capture-*.ndjson

# what the runtime sent back, versus what the client got
jq -r 'select(.event == "body") | "\(.hop) \(.text)"' capture-*.ndjson
```

Three properties are load-bearing:

- **It is a tee, never a transform.** The capture cannot alter a byte in either direction, and every write swallows its own failures — an instrument that can break the thing it measures is worse than none. A failing file handle disables the capture and logs once.
- **Both hops are recorded.** Capturing only the upstream side would take the byte-for-byte relay on faith, which is the very thing the capture exists to check.
- **It is bounded.** A single agent request carries the whole conversation, so bodies are capped per request and per hop, and the truncation is written down rather than left to look like a damaged response.

Headers whose names denote a secret are redacted. **Bodies are not**, because the body is the thing being inspected — so a capture holds entire conversations, and anything an upstream echoes back inside its own response. `serve --debug` says so on stderr on every run, and the file should be treated as sensitive.

The gateway must preserve streaming semantics.

A streaming request remains active until:

- upstream closes,
- client disconnects,
- cancellation occurs,
- or a fatal upstream failure occurs.

---

## `/v1/models`

The gateway should expose the configured logical model ids, not merely whatever process happens to be running.

Example:

```json
{
  "object": "list",
  "data": [
    {
      "id": "coding-fast",
      "object": "model",
      "owned_by": "llm-runtime-dock"
    },
    {
      "id": "coding-quality",
      "object": "model",
      "owned_by": "llm-runtime-dock"
    }
  ]
}
```

A model that is not currently loaded still appears in `/v1/models`.

A model with `disabled: true` does not ([§12](05-configuration.md#configuration)). It is configuration rather than catalogue: the list omits it, and a request naming it is refused with `MODEL_NOT_FOUND` — 404, with a message saying the entry is disabled rather than unknown, since it is plainly in the file. That refusal is the single place the flag is enforced; everywhere else the entry is simply left out of a list, which is what keeps it from ever reaching the scheduler.
