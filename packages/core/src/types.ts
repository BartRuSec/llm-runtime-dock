/** Core domain types. Nothing here knows about a concrete runtime (spec §6). */

/** API protocols a runtime can serve. The gateway proxies, never translates (§14). */
export type Surface = 'openai' | 'anthropic';

/** How an adapter frees the resident model slot (§8). */
export type ModelRelease = 'unload_model' | 'stop_server';

/** Runtime state machine (§8). Describes one entry's grip on the resident slot. */
export type RuntimeState =
  'stopped' | 'starting' | 'loading' | 'ready' | 'draining' | 'stopping' | 'failed';

/** Whether the gateway spawned the serving process or attached to an existing one (§8). */
export type ServerOwnership = 'spawned' | 'attached' | 'unknown';

/** An upstream credential source. The value itself is resolved lazily and never logged. */
export interface AuthConfig {
  readonly apiKeyEnv?: string;
  readonly apiKeyFile?: string;
}

/**
 * A concrete, fully specified way of serving one model (§3).
 * `options` is opaque to core: only the owning adapter knows what it means.
 */
export interface RuntimeInstance {
  /** Logical model id. The key in `models:`, and what `/v1/models` advertises. */
  readonly id: string;
  /** The key in `runtimes:` this instance resolves through (§12). */
  readonly runtimeId: string;
  readonly adapterId: string;
  /** The model reference the runtime itself understands. */
  readonly backendModel: string;
  /**
   * The name written into agent configurations (§23). The entry's `name`, or its
   * `backend_model` when `name` is unset — the full name a user recognizes, not
   * the logical id.
   */
  readonly displayName: string;
  /** From the declared runtime, so two models on one runtime always agree on it. */
  readonly host: string;
  readonly port: number | undefined;
  /**
   * Adapter-validated launch options: the runtime's server-scoped options merged
   * under the model's own. Core treats this as opaque.
   */
  readonly options: unknown;
  /** Raw argv escape hatch, already checked against the adapter's reserved list. */
  readonly extraArgs: readonly string[];
  /**
   * This entry is never unloaded by a switch (§8).
   *
   * The scheduler keeps it in memory while other entries rotate through the
   * slot, and hands the serving token to and from it without loading or
   * releasing anything. Memory residency, not concurrency: one entry still
   * answers at a time.
   */
  readonly keepResident: boolean;
  /**
   * This entry is configuration only: it is never served (§12).
   *
   * It is omitted from `/v1/models`, refused by resolution (§13) so it can
   * never reach the scheduler, and left out of every coding agent's
   * configuration (§23). The entry still exists — it survives re-probing, and
   * `doctor` and `models` report it — which is the whole difference between
   * this and deleting it.
   */
  readonly disabled: boolean;
  /** From the declared runtime: a credential is a property of the server (§12). */
  readonly auth: AuthConfig | undefined;
  /** The unvalidated `models:` entry as written in YAML. */
  readonly raw: Readonly<Record<string, unknown>>;
  /**
   * The unvalidated `runtimes:` entry. Only the owning adapter may read it, and
   * only for fields core has no opinion about — the custom adapter's
   * `process`/`health`/`model_discovery`/`endpoint` blocks live here.
   */
  readonly rawRuntime: Readonly<Record<string, unknown>>;
}

export interface HealthStatus {
  /** `loading` is a real state, not a failure: a runtime may bind its port and answer 503 while loading (§16). */
  readonly state: 'ready' | 'loading' | 'unreachable' | 'error';
  readonly httpStatus?: number;
  readonly detail?: string;
  /**
   * The parsed JSON body, when the endpoint answered with one.
   *
   * Discovery uses it to confirm a server is this runtime's own before claiming
   * it (§22): two adapters may share a default port, and a probe that cannot
   * tell whose server it reached would write a configuration pointing at the
   * wrong backend. The lifecycle path ignores it.
   */
  readonly body?: unknown;
}

export interface ModelInfo {
  readonly id: string;
  /** Present only where the runtime states it; never guessed. */
  readonly contextLength?: number;
  readonly loaded?: boolean;
  readonly pinned?: boolean;
}

export interface Capabilities {
  readonly surfaces: readonly Surface[];
  readonly streaming: boolean;
}

/** Where core must send inference, and what to attach when the client sent no credential. */
export interface Endpoint {
  /** Base URL including the API version prefix, e.g. `http://127.0.0.1:8000/v1`. */
  readonly baseUrl: string;
  /** Outbound auth header, used only when the client sent no `Authorization` (§12). */
  readonly authHeader?: { readonly name: string; readonly value: string };
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

/** Where a probe should look. Deliberately carries no config entry (§22). */
export interface ProbeTarget {
  readonly url: string;
  /** Credential supplied by `--api-key-env` or by a matching configured entry. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

/** One question an adapter asks `lrd probe --interactive` to render (§22). */
export type ProbeQuestionType = 'string' | 'number' | 'confirm';

export interface ProbeQuestion {
  /**
   * Closed key space on purpose: these are the four things core knows how to
   * turn into a probe. An adapter-specific key would be a second option
   * renderer competing with `optionSpecs`, which §7 forbids.
   */
  readonly key: 'host' | 'port' | 'api_key_env' | 'start';
  readonly label: string;
  readonly type: ProbeQuestionType;
  readonly default?: string | number | boolean;
}

/** What `probeQuestions` came back with. Keys match `ProbeQuestion['key']`. */
export interface ProbeAnswers {
  readonly host?: string;
  readonly port?: number;
  readonly api_key_env?: string;
  readonly start?: boolean;
}

/**
 * Where `lrd probe --start` should bring a server up (§22).
 *
 * Carries no `RuntimeInstance` and no model, for the same reason `probe` does
 * not (§7): discovery produces configuration, so it cannot require it.
 */
export interface ProbeStartTarget {
  readonly host: string;
  readonly port: number | undefined;
  readonly timeoutMs?: number;
}

export interface ProbeStartResult {
  /** The endpoint the server actually came up on, read back from the runtime. */
  readonly url: string;
}

export interface DiscoveredModel {
  /**
   * The reference the runtime itself understands — what `backend_model` gets.
   * May contain characters a YAML key should not, such as the `/` in a
   * Hugging Face repo id (`Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality`).
   */
  readonly id: string;
  /**
   * A friendly logical id to key the config entry with, where `id` itself is
   * not suitable. §22 assumed the two were always the same; repo ids break that,
   * so an adapter may suggest a key and leave `id` as the backend reference.
   */
  readonly suggestedId?: string;
  readonly contextLength?: number;
  readonly loaded?: boolean;
  /**
   * Why the runtime says this model cannot be served, when it lists a model it
   * also declares unusable. Discovery skips those and reports the reason, rather
   * than writing an entry whose first switch would fail (§22).
   */
  readonly unusable?: string;
}

/**
 * Probe outcome. Three states, because "running, credential required" must never
 * be reported as "not running" (§22).
 */
export type ProbeResult =
  | {
      readonly status: 'running';
      readonly url: string;
      /** What the server is serving right now. */
      readonly models: DiscoveredModel[];
      readonly available?: DiscoveredModel[];
    }
  | {
      readonly status: 'not_running';
      readonly url: string;
      readonly detail?: string;
      readonly available?: DiscoveredModel[];
    }
  | { readonly status: 'auth_required'; readonly url: string; readonly detail?: string }
  | {
      /**
       * The runtime's own executable is not available, so this adapter cannot
       * start or drive anything here. Never reported as "not running": nothing
       * is down, nothing is installed.
       *
       * Most adapters answer this without asking anything over HTTP, because
       * the executable is how they drive the server at all. An adapter whose
       * lifecycle is pure HTTP — Ollama — asks first and falls back to this
       * only when nothing answered either.
       */
      readonly status: 'not_installed';
      readonly url: string;
      readonly detail: string;
      readonly executable: string;
    }
  | {
      /**
       * Something answered, and it is not this runtime. Distinct from
       * `not_running` because the port is *taken*: `--save` must not write it as
       * this runtime's endpoint (§22).
       */
      readonly status: 'foreign_server';
      readonly url: string;
      readonly detail: string;
    };

/** Result of an adapter's identity verification (§17). */
export interface IdentityCheck {
  readonly ok: boolean;
  /** What the runtime says it is serving, for the error message. */
  readonly served: readonly string[];
  readonly detail?: string;
}
