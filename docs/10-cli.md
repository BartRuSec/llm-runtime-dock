# Command-line interface

Every `lrd` command, what it talks to, and how it behaves when the thing it
needs is missing.

---

## CLI

The binary is `lrd` ([§4](02-architecture.md#monorepo)).

```text
lrd serve
lrd status
lrd probe [runtime]
lrd apply <agent>
lrd doctor
lrd models
lrd runtimes
lrd switch <model>
lrd logs <runtime>
```

Global options, accepted by every command:

```text
--config <path>   explicit configuration file ([§12](05-configuration.md#configuration))
--json            machine-readable output
--no-color        never colourise output
```

Commands that talk to a running gateway also accept `--endpoint <url>`, defaulting to the configured `server.host:port`.

#### Colour

Output is colourised only when this run owns the terminal. Colour is off under
`--no-color`, under a non-empty `NO_COLOR`, under `--json`, on `TERM=dumb`, and
whenever stdout is not a TTY — a pipe, a file, CI. `FORCE_COLOR` turns it back
on where there is no terminal to detect (`0`, `false` and `off` mean off);
`NO_COLOR` still wins over it, because the documented way to refuse colour must
not be defeated by an environment that happens to set both.

Colour is decoration and nothing else: strip the escape sequences and the bytes
are what the same command prints without them. `--json` is never colourised, so
its output stays byte-clean for a parser.

#### `serve`

Start the gateway. This is what a global install exists for.

`--host` and `--port` override the configured bind address.

`--debug` captures every proxied request and response to an NDJSON file, and `--debug-dir <path>` says where (default: a `llm-runtime-dock` subdirectory of the system temp directory). `LRD_DEBUG` and `LRD_DEBUG_DIR` do the same from the environment; `LRD_DEBUG=0`, `false` or `off` mean off, so the documented way to disable it does not accidentally enable it.

The capture is described in [§14](06-gateway-api.md#gateway-api). It holds whole conversations, so `serve --debug` prints the file's path and a warning to stderr on every run.

`serve` announces itself as `lrd <version>` on stderr before anything else, so a
report from a global install says which binary answered. What it started is then
one aligned block on stdout, in the same shape `status` uses:

```text
config:   ~/.config/llm-runtime-dock/config.yaml
endpoint: http://127.0.0.1:8787
models:   coding-quality, coding-fast
```

`serve` is the one command that prints its own `config:` row rather than the
loose breadcrumb every other command emits, so the path is not reported twice.

Under `--json` both streams stay machine-readable — stdout carries nothing but
the JSON surface and stderr nothing but JSON log lines — so the banner and this
block are skipped there.

##### Stopping it

`SIGINT`, `SIGTERM` and `SIGHUP` all shut the gateway down and release every
loaded model, `keep_resident` entries included ([§8](03-lifecycle.md#lifecycle)).
`SIGHUP` matters as much as the other two: closing the terminal sends it, and
neither macOS nor Linux kills a child when its parent dies, so without it every
runtime the gateway started would be left holding the GPU.

The wait for in-flight requests is **bounded**. `server.close()` alone resolves
only once every connection has ended, and a streaming response never ends on its
own — a shutdown during one would hang forever and never reach the release step.
So idle keep-alive sockets are dropped at once, active ones get a short grace,
which is a **ceiling and not a fixed wait** — the release runs the moment the
last request finishes, so an idle gateway stops immediately and a two-second
response costs two seconds, not ten. Only a request still running when the grace
expires is cut off, and its socket destroyed. This is not the scheduler's drain timeout
([§24](03-lifecycle.md#scheduler)): draining exists so a _switch_ never cuts off
a client that will still be there afterwards, whereas here the process is going
away regardless and waiting longer only delays freeing memory.

A second signal exits immediately and says so, rather than leaving a hard kill
as the only way out — that path releases nothing, and whatever is loaded stays
loaded.

#### `status`

Ask a running gateway what it is doing, via `GET /status` ([§14](06-gateway-api.md#gateway-api)):

```text
gateway:  running at http://127.0.0.1:8787
config:   ~/.config/llm-runtime-dock/config.yaml
resident: coding-quality (mtplx, spawned)
model:    Qwen3.8-27B
release:  stop_server
state:    ready
queue:    0
```

The `config:` row is the path the _gateway_ reported, so `status` — like
`serve` — prints it in place of the breadcrumb rather than after it.

If no gateway answers, say so plainly and exit non-zero:

```text
gateway not running at http://127.0.0.1:8787
```

Never a stack trace from a refused connection. `status` is what people run _because_ something looks wrong, so it has to behave well when everything is wrong.

#### `probe`

Ask the backends themselves what they serve ([§22](07-discovery.md#runtime-discovery)). This needs no gateway and no configuration — it is how a configuration gets written in the first place.

```bash
lrd probe                                              # every declared runtime, plus every adapter none covers
lrd probe mtplx                                        # one runtime, or every runtime of one adapter
lrd probe mtplx --port=8001                            # one target, explicit port
lrd probe mtplx --url=http://127.0.0.1:8000 --save     # ...and write it to the config
lrd probe --interactive                                # ask what to probe, then offer to save
lrd probe lm-studio --start                            # start it if it is down, then probe again
```

The argument names a declared runtime, or an adapter — in which case every
declared runtime of that adapter is probed, or the adapter's own default target
when none is declared yet.

A runtime with `discovery: false` ([§22](07-discovery.md#runtime-discovery)) is
left out of both the bare sweep and the adapter fan-out, and one muted line names
what was skipped. Naming it directly probes it anyway; that is the only override.

Options:

```text
--url <url>          endpoint to probe instead of the runtime's or adapter's default
--host <host>        override the host for a single probe target
--port <port>        override the port for a single probe target
--api-key-env <VAR>  credential for runtimes that require one ([§22](07-discovery.md#runtime-discovery))
--interactive        ask per runtime what to probe, then offer to save
--start              bring up a backend the probe found down, then probe again ([§22](07-discovery.md#runtime-discovery))
--save               refresh this runtime's entries from what was found ([§22](07-discovery.md#runtime-discovery))
--dry-run            with --save: print the resulting configuration and any
                     name conflicts, write nothing
--force              with --save: remove configured models the probe did not
                     find, without asking
```

`--url`, `--host` and `--port` apply to a single probe target, so a sweep over
several runtimes has to name one first. The precedence between them and the
configured endpoint is stated once, in [§22](07-discovery.md#runtime-discovery).

`discovery` is accepted as an alias for `probe`.

Without `--save`, `probe` prints and exits. With it, the target path is printed, the previous configuration is backed up, this runtime's entries are refreshed from what was found, and every other runtime's entries are left alone. A model that already belongs to another runtime is reported as `left on <runtime>` and not touched; one that nothing owns and several runtimes of a single adapter offer is asked about on a terminal, and otherwise left unwritten ([§22](07-discovery.md#runtime-discovery)). Refreshed means the five fields discovery writes — `adapter`, `host` and `port` on the declared runtime, `runtime` and `backend_model` on the model — and nothing else: options, auth and comments on an entry survive a re-probe ([§22](07-discovery.md#runtime-discovery)).

A configured model the probe did not find is reported, not deleted. `probe --save` asks about those in one list with nothing pre-selected, so enter keeps them all; `--force` removes them unasked. When there is no terminal to ask on — `--json`, a pipe, CI — they are kept and named, and the command still succeeds. `--force` without `--save` is an error rather than a flag that did nothing.

`probe` and `status` answer different questions from different sources: `probe` asks the backends what exists, `status` asks the gateway what is resident. Their output should not look interchangeable.

#### `apply`

Write the gateway into a coding agent's own configuration ([§23](08-agents.md#agent-integrations)), so the agent can reach what the dock exposes without anyone editing JSON by hand.

```bash
lrd apply opencode
lrd apply claude
lrd apply codex
lrd apply --all                       # every agent named in agents:
lrd apply claude --opus coding-fast   # override the configured mapping
lrd apply codex --dry-run             # print the resulting file, write nothing
```

Options:

```text
--all         apply to every agent present in the agents: section
--dry-run     print the resulting configuration, write nothing
```

Role overrides are per agent: `--opus`, `--sonnet`, `--haiku` for Claude Code, `--model` for Codex and OpenCode. They override the `agents:` mapping for one run without changing it.

Apply prints the file it is about to write, backs up the previous version, and merges — never replaces ([§23](08-agents.md#agent-integrations)).

An agent the configuration does not mention is not an error. For OpenCode the
provider block is written and the existing default model is left alone; for
Claude Code and Codex, whose configuration is meaningless without a model, the
command asks, offering the logical model ids from `models:`.

`--all` keeps its narrower meaning: **every agent named in `agents:`**, and
nothing else. An agent the configuration does not mention has to be named
explicitly — `lrd apply opencode` — so that `--all` stays a predictable,
non-interactive operation over what the file already declares, rather than
something that walks every registered agent and asks about each one.

Asking needs a terminal on both ends. Under `--json`, in a pipeline or in CI
there is nothing to ask, so the command fails with `CONFIG_INVALID` and the hint
to add an `agents:` block — it never blocks on a prompt nobody can answer.

#### `doctor`

Validate:

- config, and report which file was loaded;
- adapters;
- executable availability;
- runtime configuration;
- adapter options against each adapter's schema, in the section each belongs to;
- absence of reserved arguments in `options` and `extra_args`;
- declared runtimes no model names;
- pinned models that would block the resident slot;
- every `agents:` role against `models:` and against the runtime's supported surfaces;
- whether each configured agent is installed and its config file readable;
- endpoint connectivity where applicable.

#### `models`

Show configured logical model ids with their runtime, backend model and state.

#### `runtimes`

Show the declared `runtimes:` section: each runtime's adapter, endpoint, the
models that name it, how it frees the resident slot, and its state. A runtime no
model names is listed too — it is legal, and is what `probe --save` writes first.

#### `switch`

Make a logical model id resident, through `POST /switch` ([§14](06-gateway-api.md#gateway-api)). Requires a running gateway and fails the same way `status` does when there is none.

#### `logs`

Show or follow runtime process logs where available.

#### Shared code

The CLI is a client, not a second implementation. `serve`, `doctor` and `probe` call the same core services the gateway uses; `status` and `switch` are HTTP clients of a running gateway. No orchestration logic lives in command handlers.
