# Error model

Two namespaces that must not be mixed, and the failure modes each one covers.

---

## Failure Handling

Handle at least:

- executable not found
- process exits during startup
- startup timeout
- health timeout
- model mismatch
- runtime crash while serving
- stop timeout
- upstream connection failure
- client disconnect
- cancellation
- invalid configuration
- duplicate model IDs
- unknown model id
- unknown adapter
- invalid adapter options
- reserved argument used in `options` or `extra_args`
- conflicting server-scoped options among entries sharing an endpoint
- discovered model ids that collide with each other or with existing entries
- discovered model ids that are not safe to write into configuration
- CLI command needing a gateway when none is running
- a request on an API surface the target runtime does not serve
- a coding agent configuration that cannot be parsed or written
- a role mapped to a model whose runtime lacks the required surface
- the resident slot is held by a model that cannot be released
- a pinned model blocks the slot
- unload fails or leaves more than one model resident
- upstream rejects the request as unauthorized

Errors should be typed and actionable.

They fall into two namespaces that must not be mixed, because they surface in different places.

#### Returned by the gateway

Mapped to OpenAI-style HTTP error responses:

```text
RUNTIME_START_FAILED
RUNTIME_READY_TIMEOUT
RUNTIME_MODEL_MISMATCH
RUNTIME_STOP_FAILED
RUNTIME_SLOT_BUSY
RUNTIME_MODEL_PINNED
RUNTIME_UNLOAD_FAILED
MODEL_NOT_FOUND
ADAPTER_NOT_FOUND
UPSTREAM_UNAVAILABLE
UPSTREAM_UNAUTHORIZED
UPSTREAM_SURFACE_UNSUPPORTED
```

#### Reported by the CLI

Configuration-time and command-time failures. These exit non-zero with a readable message; they are never HTTP responses, and `GATEWAY_NOT_RUNNING` by definition cannot be one:

```text
CONFIG_INVALID
RUNTIME_OPTIONS_INVALID
RUNTIME_OPTION_RESERVED
DISCOVERY_NAME_CONFLICT
DISCOVERY_INVALID_MODEL_ID
DISCOVERY_AUTH_REQUIRED
GATEWAY_NOT_RUNNING
AGENT_NOT_INSTALLED
AGENT_SURFACE_UNSUPPORTED
AGENT_SECRET_UNSUPPORTED
AGENT_CONFIG_UNREADABLE
SERVER_AUTH_UNRESOLVED
SERVER_KEY_ALREADY_CONFIGURED
```

`AGENT_SECRET_UNSUPPORTED` also covers a second case since [§28](01-overview.md#security): a gateway key with no variable name to reference (one `lrd key generate` wrote into a file rather than an env var), applied to an agent whose format has no adjacent literal-secret field — Codex's `env_key`, currently. `SERVER_AUTH_UNRESOLVED` is the fail-closed case for `server.auth` itself: an explicit `api_key_env`/`api_key_file` that resolves to nothing, raised by `lrd serve`, `lrd doctor` and `lrd apply` alike whenever the credential a command needs cannot be found — never by the OOTB `LRD_API_KEY` default, whose absence just means auth is off. `SERVER_KEY_ALREADY_CONFIGURED` is `lrd key generate` refusing to overwrite an existing `server.auth` without `--force`.

Configuration errors reach the gateway too — it refuses to start on them — but they are reported at load time, not as a response to a request.
