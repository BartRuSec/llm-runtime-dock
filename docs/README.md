# llm-runtime-dock — specification

This is the complete specification of `llm-runtime-dock`, and the source of truth
for what the project does and why. It describes the system as built.

Looking for how to **use** the tool — install it, write a config, point a coding
agent at it? That is the [README](../README.md) at the repository root. These
documents are the design: the invariants, the contracts, and the reasoning behind
the decisions that are easy to get wrong.

## Contents

| #   | document                                    | what it covers                                                                                             |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | [Overview](01-overview.md)                  | purpose, design principles, terminology, the security model, and what is deliberately out of scope         |
| 2   | [Architecture](02-architecture.md)          | workspace layout, dependency direction, plugin registration, developer workflow                            |
| 3   | [Lifecycle and scheduling](03-lifecycle.md) | the resident slot, the state machine, switching, draining, readiness, identity verification, observability |
| 4   | [Runtime adapters](04-adapters.md)          | the adapter contract, then MTPLX, LM Studio, oMLX, Ollama and the declarative custom adapter               |
| 5   | [Configuration](05-configuration.md)        | file resolution, entry shape, reserved arguments, upstream auth, model resolution                          |
| 6   | [Gateway API](06-gateway-api.md)            | the HTTP surface, both protocols, `/status` and `/switch`                                                  |
| 7   | [Runtime discovery](07-discovery.md)        | `lrd probe`, and writing configuration from what backends report                                           |
| 8   | [Coding agent integrations](08-agents.md)   | `lrd apply` and the per-agent configuration formats                                                        |
| 9   | [Error model](09-errors.md)                 | the two error namespaces and every failure they cover                                                      |
| 10  | [Command-line interface](10-cli.md)         | every `lrd` command                                                                                        |
| 11  | [Testing](11-testing.md)                    | the fake-runtime fixture, required scenarios, acceptance criteria                                          |

## Reading order

The three documents that carry the invariants everything else depends on are
[Overview](01-overview.md), [Lifecycle and scheduling](03-lifecycle.md) and
[Runtime adapters](04-adapters.md). If you read nothing else, read the resident
slot in [§8](03-lifecycle.md#lifecycle): one model in memory at a time, across
every adapter, is the constraint the rest of the design exists to serve — and
`keep_resident` is the single, explicit way a configuration steps outside it.

## Section numbers

These documents cross-reference each other by section number — `§8`, `§17`, `§22`
— because the numbering is stable and terse enough to use mid-sentence. Every
such reference is a link. The mapping:

| §     | document                             | §     | document                             |
| ----- | ------------------------------------ | ----- | ------------------------------------ |
| 1–3   | [Overview](01-overview.md)           | 18–20 | [Runtime adapters](04-adapters.md)   |
| 4–6   | [Architecture](02-architecture.md)   | 21    | [Architecture](02-architecture.md)   |
| 7     | [Runtime adapters](04-adapters.md)   | 22    | [Runtime discovery](07-discovery.md) |
| 8–10  | [Lifecycle](03-lifecycle.md)         | 23    | [Agent integrations](08-agents.md)   |
| 11    | [Runtime adapters](04-adapters.md)   | 24    | [Lifecycle](03-lifecycle.md)         |
| 12–13 | [Configuration](05-configuration.md) | 25    | [Error model](09-errors.md)          |
| 14–15 | [Gateway API](06-gateway-api.md)     | 26    | [Lifecycle](03-lifecycle.md)         |
| 16–17 | [Lifecycle](03-lifecycle.md)         | 27    | [CLI](10-cli.md)                     |
| 28    | [Overview](01-overview.md)           | 32    | [Architecture](02-architecture.md)   |
| 29    | [Lifecycle](03-lifecycle.md)         | 33    | [Agent integrations](08-agents.md)   |
| 30    | [Overview](01-overview.md)           | 34    | [Testing](11-testing.md)             |
| 31    | [Testing](11-testing.md)             | 35–36 | [Overview](01-overview.md)           |
| 37    | [Runtime adapters](04-adapters.md)   |       |                                      |
