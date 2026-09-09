# Runtime discovery

How `lrd probe` answers what is running on this machine before any
configuration exists, and how it writes that answer into a config file.

---

## Runtime Discovery

Discovery answers a question the user has before they have a configuration: _what is running on this machine, and what does it serve?_

It is what makes the gateway usable without hand-writing YAML.

#### Adapters implement it

Probing is runtime-specific — the endpoint, the response shape, the auth — so `probe()` lives in the adapter ([§7](04-adapters.md#runtime-adapter-interface)). Core only decides which adapters to ask, merges their answers and, when asked, writes configuration.

Each plugin therefore declares a **default probe target**: where this runtime listens when nobody says otherwise.

| adapter   | default probe target     |
| --------- | ------------------------ |
| mtplx     | `http://127.0.0.1:8000`  |
| lm-studio | `http://127.0.0.1:1234`  |
| omlx      | `http://127.0.0.1:8000`  |
| ollama    | `http://127.0.0.1:11434` |

Each is one constant per adapter package, read both by `defaultProbeTarget` and
by the `port ?? default` fallback the adapter applies when an entry names none.
Splitting them would let a probe find a server the gateway then fails to reach.

Core must not hardcode these, for the same reason it does not map CLI flags ([§6](02-architecture.md#core-architecture)).

Two adapters sharing a default port is not a mistake to design away — MTPLX and
oMLX both default to `8000` here. It is handled instead, twice over: an
adapter whose executable is absent answers before any request goes out, and an
adapter that does reach a server asks whether that server is its own before
claiming it. Both are described below.

Handled is not the same as fine: the runtime that lost the port still has
nowhere to listen, so one of them has to move ([§12](05-configuration.md#configuration)).

Where a probe looks, stated once and applied everywhere:

```text
--url  >  --host/--port  >  the runtimes: entry  >  adapter.defaultProbeTarget  >  error
```

A declared runtime is therefore authoritative once one exists, and the adapter
default is only the answer before any configuration does.

#### A runtime discovery does not touch

`discovery: false` on a `runtimes:` entry marks it **managed by hand**. A sweep
skips it completely: no request, no line in the report, nothing in the rendered
configuration, and `--save` writes neither its entry nor its models. It stays a
perfectly ordinary runtime everywhere else — the gateway starts it, stops it and
proxies to it, and `doctor` checks it — because the flag scopes to discovery and
nothing else.

It exists because `keep_resident` creates runtimes that hold exactly one chosen
model ([§8](03-lifecycle.md#lifecycle)). A catalogue-based adapter offers _every_
installed model to _every_ one of its runtimes, so without the flag a
single-purpose server is permanently offered four models it must never serve.
That is noise by construction, not a configuration mistake to be reported.

**Naming the runtime overrides it**, and nothing else does: `lrd probe
mtplx_resident` probes it, while a bare sweep and the adapter fan-out `lrd probe
mtplx` do not. Without that door the flag would be a trap, with no way to
re-probe a runtime after deliberately changing it.

Two things follow that are easy to get wrong, and both fail silently:

- an excluded runtime still **covers its adapter**. Otherwise the "every adapter
  no declared runtime covers" rule below would probe that adapter at its default
  target — resurrecting the excluded runtime under the adapter's own id, at an
  endpoint nobody declared;
- "every runtime of this adapter is excluded" is not "this adapter has no
  runtimes". The fan-out must report that there is nothing to probe rather than
  falling back to the default target.

#### What a probe returns

For each model a running server reports, the adapter returns at least its id, and whatever else it can state without guessing — context length and capability where the runtime exposes them.

A probe reports one of these per runtime, and each is useful:

```text
mtplx      http://127.0.0.1:8000   1 model
lm-studio  http://127.0.0.1:1234   not running
omlx       http://127.0.0.1:8000   not this runtime
ollama     http://127.0.0.1:11434  running, serving 0 models, 2 installed
custom     http://127.0.0.1:9100   not installed
```

"Not running" is an answer, not an error.

A probe that finds the runtime's own executable missing reports **not
installed** and asks nothing over HTTP: an adapter that can neither start nor
drive a server has no endpoint worth recording, and that is not the same
statement as "the server is down". A probe that reaches a server which is not
this runtime reports **not this runtime** — distinct from "not running", because
the port is _taken_. Neither writes a `runtimes:` entry, and neither makes a
configured model stale.

Probing is read-only, with exactly one flag-gated exception: `--start` brings up
a server the probe has just found **down**, and then probes again. Nothing else
about a probe starts, stops, loads or unloads anything — and `--start` itself
never stops anything, never loads a model, and never touches a server that
answered.

#### Whose server is this?

Where two adapters share a default port, a probe that could not tell them apart
would report the same models twice and then write a configuration aimed at the
wrong backend — an entry that fails on its first switch, which is the failure
[§17](03-lifecycle.md#model-identity-verification) exists to prevent, moved
earlier and made harder to see.

So the identity check lives in the adapter, next to `probe()`, because the signal
is runtime-specific: MTPLX answers `/health` with its launch descriptor (the
model it loaded, the backend serving it, the profile it runs under), while oMLX
serves `/v1/models/status`, the residency endpoint nothing else here has.

Two rules keep it honest. It runs only on a **ready** health — a server still
loading answers 503 with a short status body, and that server is ours. And a
credential rejection is not a disqualification: 401 or 403 means a server is
there and wants a key, which is `auth_required`, not somebody else's server.

#### Starting a backend from a probe

`--start` exists because the most common probe result on a laptop is "not
running", and the next thing the user does is start the thing by hand and probe
again.

It is not `start(runtime)`. That takes a `RuntimeInstance` carrying a
`backend_model` — and a probe by definition has not got one, which is the whole
point of `probe()` taking no config entry
([§7](04-adapters.md#runtime-adapter-interface)). So an adapter that can be
started from a probe implements `startServer(target)` instead, which takes a host
and a port and returns the URL the server actually came up on.

Reading the port back matters: a runtime may honour its own configured port
rather than the one asked for, and re-probing the wrong port would report "not
running" about a server that had just started.

Only an adapter with a **daemon-style** CLI command implements it — one that
returns while the server keeps running. `lms server start` and `omlx start` are
two; `mtplx serve` and `ollama serve` are not. A foreground `serve` is spawned without `detached`, so
a server `lrd probe` started would die when the command exits.

Which of them can report the port back differs, and the adapter says so honestly
rather than guessing:

| runtime   | start command      | port                                                                                                                                                                                                                                                                                              |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lm-studio | `lms server start` | takes `--port`, and `lms server status --json` reads back what it actually used                                                                                                                                                                                                                   |
| omlx      | `omlx start`       | takes none: the managed server uses oMLX's own settings, which the gateway must not read ([§10](03-lifecycle.md#process--cli-lifecycle)). The endpoint asked for is reported, and checked — a server that started but answers nowhere is an error naming the mismatch, not a silent "not running" |

**MTPLX is the one that refuses, and the reason is not only mechanical.**
`mtplx serve` needs `--model`, which a probe cannot know — but more to the point,
starting it would add nothing: MTPLX reports its whole installed catalogue from
`mtplx models --json` whether or not a server is up, so a probe of a stopped
MTPLX already has everything configuration needs. Starting it would load one
model and then "discover" the model it was just told to load.

That asymmetry is exactly why the offer is per adapter. LM Studio and oMLX report
**nothing** when their server is down, so for them starting it is the difference
between a probe that finds models and one that finds none.

Nothing is started that the probe did not just find down.

#### Asking instead of guessing

`--interactive` walks the probe subjects one at a time: probe this one? then the
adapter's own questions, then an offer to save what was found.

The first question names the **runtime**, not an endpoint. Putting the address in
it — "probe mtplx at http://127.0.0.1:8000?" — reads as though the address were
settled, so somebody who wanted a different port answers no and never reaches the
question that would have let them say so. The address belongs to the questions
that follow, where it is the default of `host` and `port` and can be changed.

The questions are **declared, not rendered, by the adapter**: `probeQuestions` is
a list of `{ key, label, type, default }`, and one file in the CLI is the only
place that turns one into a terminal prompt. An adapter states what to ask; it
never learns how. The key space is deliberately closed — host, port, credential
variable, start — because an adapter-specific key would be a second option
renderer competing with `optionSpecs`, which [§7](04-adapters.md#runtime-adapter-interface) forbids.

Explicit flags pre-fill the defaults and an answer wins over a flag. Unlike
stale-entry removal, an interactive probe that cannot ask has no useful fallback
— probing the defaults is precisely what the user asked not to do — so
`--interactive` under `--json`, or with no terminal, is an **error** rather than
a silent no-op.

#### Probing something that wants a key

Discovery runs before configuration exists, so an entry's `auth` block ([§12](05-configuration.md#configuration)) is not available to it. Some runtimes need one anyway: oMLX leaves `/health` open but requires a credential on `/v1/models`.

A server that answers health and then rejects discovery with 401 or 403 is **running, credential required** — a distinct outcome, never reported as "not running". Say what is needed rather than implying nothing is there.

Two ways to supply it, both explicit:

- `--api-key-env <VAR>` on the probe command, or the same question answered under `--interactive`;
- the `auth` block of the declared runtime being probed, which is reachable by
  its key rather than by matching a host and a port — a credential is a property
  of the server, so it sits where the server is declared ([§12](05-configuration.md#configuration)).

Never read a credential out of the runtime's own settings files ([§10](03-lifecycle.md#process--cli-lifecycle)).

#### Writing configuration

With an explicit save flag, discovery becomes configuration. The endpoint that answered becomes a `runtimes:` entry; each discovered model becomes one `models:` entry naming it, keyed by the model id the server reported, with `backend_model` set to that same id.

A runtime is recorded even when its server is down and it has nothing loaded: that endpoint is exactly what the gateway needs in order to start it later, and it is what the user came to discovery for. Only "not installed" and "not this runtime" write none.

Where that id is not usable as a configuration key, the adapter may suggest a
readable one instead. A Hugging Face repo id is the real case:
`Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality` contains a `/` and does not
belong in a YAML key. The adapter then returns a `suggestedId` for the key while
`backend_model` keeps the id the server actually reported, because that is what
identity verification ([§17](03-lifecycle.md#model-identity-verification)) matches against. Collision detection runs on the key
that will be written, never on the raw id.

A probe of an OpenAI-compatible server derives its key the same way, from the
id `/v1/models` reports: `google/gemma-4-26b-a4b-qat` becomes
`google-gemma-4-26b-a4b-qat`. The separator is flattened rather than dropped,
because several publishers ship the same weights and `google/gemma-4` and
`lmstudio-community/gemma-4` are two models, not one. An id that is already a
usable key is left exactly as it is — renaming something that works would change
what clients have to send.

Discovered from the MTPLX above:

```yaml
runtimes:
  mtplx:
    adapter: mtplx
    port: 8000

models:
  mtplx-qwen38-27b-optimized-quality:
    runtime: mtplx
    backend_model: mtplx-qwen38-27b-optimized-quality
```

Rules for saving:

- Saving is a **refresh**, not a rewrite. Entries belonging to other runtimes are untouched.
- If no configuration exists, one is created with server defaults ([§12](05-configuration.md#configuration)).
- The previous file is backed up before being overwritten. Saving is destructive and must be recoverable.
- Saving happens only on an explicit flag. A bare probe prints and exits.

#### An entry the probe rediscovers keeps what the user put on it

Discovery owns exactly five fields across the two sections — `adapter`, `host`
and `port` on the declared runtime, `runtime` and `backend_model` on the model —
because those are the five it writes. On a key that already exists, those are
refreshed from what the probe reported and **nothing else is touched**:
`options`, `extra_args`, `auth`, an `aliases` list, the comment somebody left
above the entry all survive, and the entry keeps its position in the file.

Deleting the entry and writing a fresh one would be simpler and is wrong. A
configuration is hand-tuned after discovery produces it; that is the expected
workflow, not an abuse of it. Re-probing to pick up a new model must not be a
reason to lose the tuning on the models that were already there.

A runtime's `host` and `port` are written conditionally — `host` is omitted for
loopback — so refreshing them includes **deleting** one the probe no longer
warrants. Refreshing `port` while leaving a `host:` from an earlier probe would
leave the runtime pointing at an endpoint nothing answered, which is worse than
either value alone.

A model's two owned fields are unconditional, so refreshing a model never
deletes anything. The distinction is not decorative: applying the runtime rule
to a model would strip `runtime:` the moment a refresh did not produce it,
turning a valid entry into one that belongs to nobody.

#### An entry the probe does not find is not a deleted model

A configured model whose runtime was probed, and which the probe did not report,
is **stale** — and stale is not the same as unwanted. The overwhelmingly common
cause is that the runtime is not running, or that the model is simply not
loaded, which is the normal state of a machine that serves one model at a time.

So discovery reports stale entries and removes none of them on its own:

- with a terminal, it asks — one list of the stale entries, nothing
  pre-selected, so pressing enter keeps everything;
- `--force` removes all of them without asking;
- with no terminal to ask on — `--json`, a pipe, CI — they are kept, named on
  stderr, and the command still succeeds.

That last case is deliberately unlike `lrd apply`, which fails when it cannot
ask ([§23](08-agents.md#agent-integrations)). There, not asking means writing
nothing useful. Here it means keeping a correct configuration that is merely
larger than it needs to be, so `probe --save` stays usable from a script and
deletion stays something a human agreed to.

A runtime that reported nothing makes no entry stale. A probe of a server that
is down, with an empty catalogue behind it, is the worst possible moment to ask
whether to delete everything on it.

**A `runtimes:` entry is never removed.** Saving may delete a model the user
approved, and nothing else. A declared runtime whose backend is merely off is the
normal state of a laptop, and one with no models on it is what `--save` itself
writes first; `doctor` reports it as a warning rather than as something to clean
up.

#### Entries that name no runtime

Ownership — "this runtime's models" — is read off the model's `runtime:` key and
the `runtimes:` map itself. A model without a `runtime:`, or one naming a runtime
that is not declared, belongs to nobody, so `--save` may not delete it and never
even offers to: it is not the probed runtime's property to remove.

It is also invalid: `loadConfig` rejects the file, so every command that reads
configuration fails until it is fixed. Saving therefore **reports** it rather
than passing over it in silence:

```text
warning: models.ornith-1.5-35b-a3b names no runtime, so it was left as-is —
it cannot be replaced and will fail to load; point it at a declared runtime or delete it
```

Ownership is read from the raw keys, without loading the file, which is what lets
`--save` repair a configuration that `loadConfig` currently rejects — so the
undeclared-runtime case has to be recognised here too rather than left to
validation that never runs.

The one case where such an entry is written to is when discovery produces its
key: nobody owns it, so filling in the `runtime:` it is missing is a repair
rather than a collision with another runtime. It is refreshed in place like any
other rediscovered entry, so whatever else was configured on it survives.

#### Ownership, and what a collision actually is

Ownership is scoped to the runtime, but the model key space stays **flat and
global**, so one id can only ever name one entry. Three cases, and only the last
of them fails:

**A discovered id that already belongs to a runtime stays there.** It has an
owner, so discovery has nothing to add: the entry is refreshed if its own runtime
found it, and otherwise left exactly as it is and reported. Moving a configured
model to whichever server happened to list it is the one thing saving must never
do, and _failing_ on it is no better — it would block the rest of a save over an
id that was never in question.

This is not a corner case. A catalogue-based adapter reports the same catalogue
from every one of its servers: `mtplx models` does not know which port asked. So
two MTPLX runtimes always rediscover each other's models, and that shape is
required rather than unusual — a `keep_resident` entry on a `stop_server` runtime
must own its own server ([§8](03-lifecycle.md#lifecycle)), which means a second
runtime on a second port.

**An id nothing owns yet, offered by several runtimes of one adapter, is asked
about.** Those runtimes are interchangeable servers of one installation, so which
should serve the model is a matter of intent, and the user is the only one who
has it. `--save` on a terminal offers the candidates; a run that cannot ask
writes nothing for that id and says so. Nothing is guessed — the entry is simply
missing until somebody says where it goes.

**An id nothing owns yet, offered by runtimes of _different_ adapters, fails**
with `DISCOVERY_NAME_CONFLICT`, listing every conflict and leaving the
configuration untouched. This is the real collision — one model file visible to
both LM Studio and oMLX, or two backends serving genuinely different weights
under one name — and no prompt scoped to a single adapter could resolve it. The
user renames one of the entries by hand.

A dry run performs the same analysis, reports the same conflicts and asks
nothing. Seeing a conflict before committing to it is most of what a dry run is
for. A command whose only job is writing configuration must not corrupt it
silently, and last-one-wins would.

#### What a probe offers for configuration

A probe may return two different lists, and they answer different questions.
`models` is what a running server has loaded right now; `available` is the local
catalogue of what the runtime could be told to serve. Only MTPLX reports both.

A catalogue also belongs to the **installation**, not to a server, which is why
ownership above cannot come from the probe: every runtime of that adapter reports
the same list, whatever port it was asked on.

**Where a catalogue exists, it is the configuration source, and the served list
is status display only.** The two are not interchangeable, and for MTPLX they are
not even named alike: it loads `Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Balance`
and then serves it under the id `mtplx-qwen36-35b-a3b-optimized-balance`. Merging
both lists writes that one model twice — the second time with a `backend_model`
that `mtplx serve --model` does not accept, so the entry fails on its first
switch. The catalogue answers the question configuration actually asks, in the
reference a launch command takes.

A bare probe still _prints_ both, because "what is loaded" is worth knowing:

```text
mtplx  http://127.0.0.1:8000  running, serving 1 model, 3 installed (mtplx)
```

#### Models the runtime declares unusable

A runtime may list a model it also says it cannot serve. MTPLX does: its cache
records a `validation.ok` per entry, and a model without a valid runtime contract
is present on disk but not servable.

Discovery **skips those and reports why**, for the same reason it skips an unsafe
id rather than rewriting it — an entry that cannot start is worse than no entry,
because the failure surfaces at the first switch instead of at configuration
time:

```text
skipped mtplx model id "ornith-ai/Ornith-1.5-35B-A3B": MTPLX reports no valid runtime contract for this model
```

#### Discovered names are untrusted input

A discovered id travels from an HTTP response into a YAML key, then into `backend_model`, and from there into a launch command as `--model <backend_model>`.

[§11](04-adapters.md#custom-adapter) forbids interpolating request-derived values into lifecycle commands. This is different — it is configuration time, an explicit user action, and the result is a file the user can read before anything runs — but the path is real and must be constrained:

- validate every discovered id against a conservative character set;
- reject any id beginning with `-`, which could be read as a flag;
- **skip** invalid ids and report them; never sanitize them into something else, because a rewritten id no longer matches what the runtime serves and would fail identity verification ([§17](03-lifecycle.md#model-identity-verification)) in a confusing way.

The discovered configuration is a starting point for a human to review, not a trusted artifact.
