# The `RuntimeAdapter` contract

Defined in `packages/core/src/adapter.ts`; specified in
[§7](../../../../docs/04-adapters.md#runtime-adapter-interface). Supporting types
(`RuntimeInstance`, `Capabilities`, `Endpoint`, `ProbeResult`, `HealthStatus`,
`ModelInfo`, `IdentityCheck`) live in `packages/core/src/types.ts`.

## Required properties

| member                   | type                              | notes                                                                                                   |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                     | `string`                          | the value users write as `adapter:` on a `runtimes:` entry                                              |
| `modelRelease`           | `'unload_model' \| 'stop_server'` | how memory is freed; drives what the scheduler does on a switch                                         |
| `defaultProbeTarget`     | `string \| null`                  | `null` means a bare `lrd probe` skips it and `--url` is required                                        |
| `probeQuestions`         | `readonly ProbeQuestion[]`        | what `lrd probe --interactive` asks; `[]` is valid. Declared as data - only the CLI may import a prompt |
| `optionSpecs`            | `Record<string, OptionSpec>`      | curated option names; doubles as the allowlist for the reserved-arg check                               |
| `reservedArgs`           | `readonly ReservedArg[]`          | flags a user may not pass, each with a reason and what to use instead                                   |
| `serverScopedOptionKeys` | `readonly string[]`               | options belonging on the declared runtime; core rejects them on a model                                 |

## Required methods

| member                              | returns                  | notes                                                                                                                                                                   |
| ----------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateOptions(raw, context)`     | parsed options           | config-load time; throws a `CliError`. `raw` is the runtime's server-scoped options merged under the model's own; `context.runtimeEntry` is the whole `runtimes:` entry |
| `probe(target)`                     | `Promise<ProbeResult>`   | takes no `RuntimeInstance` - discovery _produces_ config, so it cannot require it. Check the binary first, and confirm the server is yours before claiming it           |
| `acquire(runtime, options?)`        | `Promise<AcquireResult>` | slot layer: make this model resident; reports `spawned` / `attached` / `unknown`                                                                                        |
| `release(runtime, options?)`        | `Promise<void>`          | slot layer: free the model                                                                                                                                              |
| `start(runtime, options?)`          | `Promise<void>`          | server layer: spawn the process                                                                                                                                         |
| `stop(runtime, options?)`           | `Promise<void>`          | server layer; only for a server this adapter spawned                                                                                                                    |
| `health(runtime)`                   | `Promise<HealthStatus>`  |                                                                                                                                                                         |
| `waitUntilReady(runtime, options?)` | `Promise<void>`          |                                                                                                                                                                         |
| `listModels(runtime)`               | `Promise<ModelInfo[]>`   |                                                                                                                                                                         |
| `verifyIdentity(runtime)`           | `Promise<IdentityCheck>` | [§17](../../../../docs/03-lifecycle.md#model-identity-verification)                                                                                                     |
| `servedModelId(runtime)`            | `string`                 | the id the backend actually serves, for the model-field rewrite                                                                                                         |
| `capabilities(runtime)`             | `Promise<Capabilities>`  | surfaces and streaming                                                                                                                                                  |
| `endpoint(runtime)`                 | `Promise<Endpoint>`      | proxy target plus an optional auth header                                                                                                                               |

## Optional methods

| member                         | used by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startServer(target)`          | `lrd probe --start`. Implement only where the CLI has a _daemon-style_ start command that returns while the server keeps running - `ProcessExecutor.spawn` is not detached, so a foreground `serve` would die with the probe. Read the port back if the CLI can report it (`lms server status --json`); if it cannot (`omlx start`), report the endpoint you were given and **check** it rather than trusting it. Skip it entirely when a stopped server still discovers everything, as MTPLX's installed catalogue does |
| `declaredLimits(runtime)`      | `lrd apply`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `requiredExecutables(runtime)` | `lrd doctor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `logs(runtime)`                | `lrd logs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`createStubAdapter` in `packages/core/tests/helpers/stubs.ts` implements every
required member and omits all three optional ones, which makes it the
minimum-conformance checklist. Read it; you cannot import it from an adapter
package, because core exports only `.`.

## Two layers, one contract

`start` / `stop` are the **server**. `acquire` / `release` are the **resident
slot**. The scheduler only ever calls `acquire` and `release`; `stop` exists for
gateway shutdown. There is deliberately no `restart` - a restart is a release
followed by an acquire, and the scheduler owns that decision.

## Launch options

Core treats options as opaque. Only the adapter knows how a name becomes a CLI
argument, and core must not grow a generic `key` -> `--kebab-flag` renderer.
Expose a curated set of named options plus `extra_args`; everything the gateway
must know about (host, port, credentials) belongs in `reservedArgs`, not in
options.

## Widening the interface

An adapter with public members beyond the contract exports a widened interface
for them, so tests keep compiling against the concrete adapter:

```ts
export interface OmlxAdapter extends RuntimeAdapter {
  serveArgs(runtime: RuntimeInstance): string[];
}
```

`MtplxAdapter` and `OmlxAdapter` add `serveArgs`; `LmStudioAdapter` adds
`loadArgs`.
