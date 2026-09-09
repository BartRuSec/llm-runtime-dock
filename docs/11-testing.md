# Testing

The fake-runtime fixture, the scenarios the suite is required to cover, and the
acceptance criteria those scenarios establish.

---

## Testing

Use unit and integration tests.

Minimum fake runtime test fixture should simulate:

- startup delay;
- health endpoint, including a period of 503 `loading` while the port is already bound;
- `/v1/models`;
- a multi-model mode with load/unload endpoints, a residency listing and auto-load on request;
- OpenAI-compatible chat completions;
- streaming, with a configurable chunk count, inter-chunk delay and chunk padding — the padding is what lets a test outrun a client that is not reading, so the gateway's backpressure path is actually entered rather than assumed;
- model mismatch;
- crash;
- stop delay.

Critical integration scenario:

```text
1. Request coding-quality.
2. Gateway starts MTPLX/qwen38.
3. Waits for readiness.
4. Verifies model identity.
5. Proxies request.
6. Start a streaming request.
7. Request coding-fast while stream is active.
8. coding-fast waits.
9. Existing stream completes.
10. qwen38 drains and stops.
11. qwen36 starts.
12. Readiness succeeds.
13. Model identity is verified.
14. Queued request is forwarded.
15. Another coding-fast request does NOT restart qwen36.
```

Also test:

- two simultaneous requests for same cold model;
- runtime crash;
- wrong model returned;
- startup timeout;
- client disconnect during stream;
- cancellation;
- malformed config;
- missing executable;
- two entries with the same `backend_model` but different `options` produce different argv and force a restart when switching between them;
- a reserved argument in `options` or `extra_args` fails config loading with `RUNTIME_OPTION_RESERVED`;
- invalid adapter options fail with `RUNTIME_OPTIONS_INVALID`;
- an `unload_model` adapter releases its model without stopping the server;
- a `stop_server` adapter releases by stopping the server, including one it attached to rather than spawned;
- cross-adapter switching, oMLX → MTPLX → oMLX, asserting exactly one resident model after each transition;
- Ollama launch, tag normalization and explicit load/unload residency;
- a multi-model runtime that auto-loads a second model is brought back to one resident model before `ready`;
- a pinned model blocking the slot fails with `RUNTIME_MODEL_PINNED` instead of leaving two models resident;
- a `keep_resident` entry on its own `stop_server` runtime survives a switch: its server is never stopped, and the rotating entries still release each other;
- a `keep_resident` entry sharing an `unload_model` server stays loaded while another model on that same server rotates — the case an adapter's stray-unloading would otherwise undo;
- returning to a model already in memory calls neither `acquire` nor `release`;
- `keep_resident` on a `stop_server` runtime shared with another entry fails config loading with `CONFIG_INVALID`, and so does the same clash spelled as two runtimes on one port;
- shutdown releases kept entries too;
- a `disabled` entry is omitted from `/v1/models` and from an agent's model list, and a request naming it is refused with `MODEL_NOT_FOUND` before the scheduler is reached ([§12](05-configuration.md#configuration));
- disabling an entry an `agents:` role names still loads the configuration, and fails only in `apply` and `doctor`;
- `probe --save` refreshing a rediscovered entry leaves a hand-written `disabled: true` in place;
- a runtime whose every model is disabled is reported as inert rather than dropping out of `doctor` silently;
- attach when a healthy server already answers, spawn when nothing does;
- a server-scoped option on a model, or a model-scoped one on a runtime, is rejected and told where it belongs ([§12](05-configuration.md#configuration));
- 503 `loading` from health is treated as `loading`, not as a failure;
- `probe` against a fake server returns its models, and against a dead port reports "not running" rather than failing;
- `probe --save` replaces only the probed adapter's entries, leaves others intact and writes a backup;
- `probe --save` on a missing config creates one;
- colliding discovered ids fail with `DISCOVERY_NAME_CONFLICT` and leave the config byte-identical;
- a discovered id starting with `-` is skipped and reported, never rewritten;
- an adapter reporting both a served list and an installed catalogue builds entries from the catalogue only, never writing one model twice;
- a model the runtime declares unusable is skipped and reported, not written;
- an existing entry that names no adapter is left in place and reported, never silently skipped over;
- an unowned entry whose key discovery produces is rewritten rather than failing as a collision;
- `POST /switch` goes through the scheduler: it drains, releases and acquires like a request-triggered switch, and a second switch for the same entry joins the first;
- `lrd status` and `lrd switch` exit non-zero with a readable message when no gateway answers;
- an Anthropic request routes, resolves and switches exactly like a chat-completions request, and its stream passes through unaltered;
- a request on a surface the runtime does not serve fails with `UPSTREAM_SURFACE_UNSUPPORTED`;
- `apply` merges into an existing agent config, preserving unrelated keys, providers and settings, and writes a backup;
- `apply` run twice produces an identical file;
- `apply claude` maps roles from `agents:`, and CLI flags override them for one run;
- `apply` refuses a role whose runtime lacks the Anthropic surface, before writing anything;
- `apply` writes an env-var reference rather than a secret, and refuses where the format cannot express one;
- `apply` on an unparseable agent config reports and leaves the file untouched;
- `apply opencode` with no `agents.opencode` writes the provider block and leaves an existing default model selection untouched;
- `apply claude`/`apply codex` with no entry in `agents:` asks once per role, from the configured model ids, and writes the answers;
- a role left unset at the prompt is not written, and choosing nothing writes no file at all;
- `apply` with no terminal to ask on fails readably instead of blocking on a prompt;
- the client's `Authorization` header reaches the upstream unchanged.

---

## Acceptance criteria

The gateway must satisfy every criterion below. Almost all of them are held by
the automated suite described above; the ones marked _(manual)_ have no
meaningful automated form and are checked by hand.

#### Gateway

- starts on localhost;
- exposes `/health`;
- exposes `/v1/models`;
- exposes `/v1/chat/completions`;
- exposes `/v1/messages` and `/v1/messages/count_tokens`;
- exposes `/status` and `/switch` on loopback only;
- supports streaming;
- returns OpenAI-compatible errors.

#### CLI

- `npm pack` produces a tarball holding only `dist/index.js`, `bin/lrd.mjs`,
  the manifest, `README.md` and `LICENSE`, and declaring no `dependencies`
  _(manual)_;
- `npm i -g <tarball>` installs one package with no `node_modules` and puts
  `lrd` on PATH _(manual)_;
- the bundle serves a real request end to end — `lrd serve`, then `/status`,
  `/v1/models` and one proxied completion _(manual)_. The e2e suite consumes
  each package's `tsc` output, not the bundle, so bundling regressions are
  invisible to it;
- `lrd serve` starts the gateway _(manual)_;
- `lrd status` reports the resident model, and fails readably with no gateway;
- `lrd probe` reports what each backend serves, without needing a config;
- `lrd probe <adapter> --url=... --save` writes a config, backing up the previous one;
- `lrd doctor` names the config file it loaded;
- `lrd switch <model>` goes through the scheduler;
- `lrd apply opencode|claude|codex` writes a working configuration, merging and backing up.

#### Agents

- each agent integration is its own package _(manual)_;
- `agents:` roles validate against `models:` and against runtime surfaces;
- an agent absent from `agents:` is still applied — without a mapping where its provider block stands alone, by asking where it does not;
- OpenCode and Codex reach the gateway over the OpenAI surface;
- Claude Code reaches it over the Anthropic surface, with opus/sonnet/haiku mapped;
- no secret is ever written into an agent's configuration.

#### Models

- `models:` entries load from YAML;
- an entry resolves to adapter + backend model + validated options;
- adapter options and `extra_args` reach the launch argv;
- reserved arguments are rejected with `RUNTIME_OPTION_RESERVED`;
- logical model IDs are exposed through `/v1/models`.

#### Runtime lifecycle

- runtime can start through CLI/process command;
- runtime can stop through CLI/process command;
- readiness is verified through HTTP;
- model identity is verified;
- switching is serialized;
- active requests drain before normal switching.

#### Plugins

- MTPLX adapter works;
- LM Studio adapter exists and uses supported CLI/process lifecycle, releasing the model without stopping the server;
- oMLX adapter works: attaches or spawns, loads and unloads through documented HTTP, holds one resident model;
- Ollama adapter works: attaches or spawns, loads and unloads through its native API, holds one resident model;
- custom adapter works from YAML;
- core does not depend on concrete adapters _(manual)_.

#### Resident slot

- at most one model is resident at any time, across all adapters, unless an entry sets `keep_resident`;
- the occupant is released before the next entry is acquired;
- cross-adapter switching works in both directions;
- a runtime that loaded an extra model on its own is corrected before `ready`;
- a model that cannot be released fails the switch instead of doubling residency;
- a kept entry is never released by a switch, and reaching it never releases the occupant;
- exactly one entry holds the serving token, whatever else is loaded;
- an adapter enforcing residency is told which models to spare.

#### Reliability

- cold start works;
- warm requests do not restart runtime;
- model switching works;
- concurrent same-model requests are handled correctly;
- streaming survives normal gateway operation;
- startup/readiness/model mismatch failures are reported.

#### Security

- default bind is localhost;
- no HTTP request can directly execute a configured command;
- custom commands are trusted configuration only.
