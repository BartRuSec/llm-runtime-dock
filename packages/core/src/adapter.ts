import type {
  Capabilities,
  Endpoint,
  HealthStatus,
  IdentityCheck,
  ModelInfo,
  ModelRelease,
  ProbeQuestion,
  ProbeResult,
  ProbeStartResult,
  ProbeStartTarget,
  ProbeTarget,
  RuntimeInstance,
  ServerOwnership,
  WaitOptions,
} from './types.js';

/**
 * Description of one curated launch option (spec §7).
 *
 * The adapter's curated schema doubles as the allowlist used by the reserved
 * argument check: a key that is neither curated nor reserved is simply invalid.
 */
export interface OptionSpec {
  /** The documented CLI flag this option maps to, e.g. `--reasoning-effort`. */
  readonly flag: string;
  readonly description?: string;
  /**
   * This key changes how the adapter renders the *other* options rather than
   * mapping to a flag of its own, so `flag` is a label and the `extra_args`
   * collision check must not treat it as a flag this adapter owns.
   */
  readonly rendersNoFlag?: boolean;
}

/**
 * An argument the gateway owns and which config must not set (§12).
 * `insteadUse` names the canonical field, so the error is actionable.
 */
export interface ReservedArg {
  /** Every spelling that must be rejected, e.g. `['-p', '--port']`. */
  readonly flags: readonly string[];
  /** The `options:` key that would render this flag, if the user tried that route. */
  readonly optionKeys?: readonly string[];
  readonly reason: string;
  readonly insteadUse: string;
}

/**
 * A runtime adapter plugin (§7, §21).
 *
 * `start`/`stop` are the *server* layer. `acquire`/`release` are the *resident
 * slot* layer. The scheduler only ever calls `acquire` and `release`; how much
 * server lifecycle that implies is the adapter's business. There is deliberately
 * no `restart`: every restart is a release followed by an acquire, driven by the
 * scheduler, so nothing can bypass draining or the slot.
 */
export interface RuntimeAdapter {
  readonly id: string;

  /** How this adapter frees the resident model slot (§8). */
  readonly modelRelease: ModelRelease;

  /**
   * Where this runtime listens when nobody says otherwise (§22).
   *
   * `null` means the adapter has no default worth guessing — a user-defined
   * runtime has no conventional port — so a bare `lrd probe` skips it and an
   * explicit `--url` is required.
   */
  readonly defaultProbeTarget: string | null;

  /** Curated launch options, keyed by the `options:` key. */
  readonly optionSpecs: Readonly<Record<string, OptionSpec>>;

  /** Arguments the gateway owns (§12). Checked against `options` and `extra_args`. */
  readonly reservedArgs: readonly ReservedArg[];

  /**
   * Options that configure the *server* rather than the model (§12). Entries
   * sharing one endpoint must agree on them.
   */
  readonly serverScopedOptionKeys: readonly string[];

  /**
   * Validate and normalize adapter-specific launch options from config.
   * Called at config load time, never per request. Throws `CliError`.
   */
  validateOptions(raw: unknown, context: OptionValidationContext): unknown;

  /**
   * Questions `lrd probe --interactive` renders for this adapter (§22, §27).
   *
   * Declarative on purpose: `packages/cli/src/prompt.ts` is the only file that
   * may import a terminal prompt, so an adapter states *what* to ask and never
   * *how* to ask it. An empty array is a valid answer, which is why this is
   * required rather than optional.
   */
  readonly probeQuestions: readonly ProbeQuestion[];

  /** Ask a running server what it serves. Runs before any config entry exists (§22). */
  probe(target: ProbeTarget): Promise<ProbeResult>;

  /**
   * Bring this runtime's server up from a probe, and report where it landed
   * (§22). Optional: `lrd probe --start` refuses, naming why, where it is absent.
   *
   * Present only where the runtime has a *daemon-style* CLI command — one that
   * returns while the server keeps running. `ProcessExecutor.spawn` is
   * `detached: false`, so a server this process spawned would die with `lrd
   * probe`; an adapter whose only start path is a foreground `serve` omits this.
   *
   * It is not `start(runtime)`: that takes a `RuntimeInstance` carrying a
   * `backend_model`, which a probe by definition has not got.
   */
  startServer?(target: ProbeStartTarget): Promise<ProbeStartResult>;

  /**
   * Make this instance the resident model: attach to a running server or spawn
   * one, load the model, and leave nothing resident that `keepLoaded` did not
   * allow.
   */
  acquire(runtime: RuntimeInstance, options?: AcquireOptions): Promise<AcquireResult>;

  /** Free the resident slot using this adapter's release mechanism (§8). */
  release(runtime: RuntimeInstance, options?: WaitOptions): Promise<void>;

  /** Bring the serving process up. Server layer only. */
  start(runtime: RuntimeInstance, options?: WaitOptions): Promise<void>;

  /**
   * Bring the serving process down. Always about the server, never about memory.
   *
   * The scheduler never calls this: it only ever calls `acquire` and `release`,
   * and how much server lifecycle that implies is the adapter's business. An
   * adapter whose server is shared with the user may therefore refuse `stop`
   * outright rather than fake it (LM Studio does).
   */
  stop(runtime: RuntimeInstance, options?: WaitOptions): Promise<void>;

  health(runtime: RuntimeInstance): Promise<HealthStatus>;

  waitUntilReady(runtime: RuntimeInstance, options?: WaitOptions): Promise<void>;

  /** Models this runtime can serve, as it reports them. */
  listModels(runtime: RuntimeInstance): Promise<ModelInfo[]>;

  /**
   * Does the runtime actually serve what this entry asked for (§17)?
   * The source of truth differs per adapter, so the check lives here.
   *
   * A multi-model adapter also confirms residency here (§16): the target loaded,
   * and nothing resident beyond it and `keepLoaded`.
   */
  verifyIdentity(runtime: RuntimeInstance, options?: ResidencyContext): Promise<IdentityCheck>;

  /**
   * The model id the upstream answers to. Core rewrites the request body's
   * `model` field to this value, so the client never sees a backend name (§13).
   */
  servedModelId(runtime: RuntimeInstance): string;

  capabilities(runtime: RuntimeInstance): Promise<Capabilities>;

  endpoint(runtime: RuntimeInstance): Promise<Endpoint>;

  /**
   * Context/output limits this entry's launch options state, for agent configs
   * that want them (§23). Only what the adapter can state; never a guess.
   */
  declaredLimits?(runtime: RuntimeInstance): DeclaredLimits;

  /**
   * Executables this adapter would run for this entry, so `doctor` can report a
   * missing one before a switch fails on it. Which binaries those are is
   * adapter knowledge, exactly like the flags they take.
   */
  requiredExecutables?(runtime: RuntimeInstance): string[];

  /** Recent process output for `lrd logs`, where the adapter spawned anything. */
  logs?(runtime: RuntimeInstance): string[];
}

export interface DeclaredLimits {
  readonly context?: number;
  readonly output?: number;
}

export interface AcquireResult {
  readonly ownership: ServerOwnership;
}

/**
 * What else is allowed to be resident, for the two operations that police it:
 * `acquire`, which unloads strays, and `verifyIdentity`, which refuses to report
 * ready when something unexpected is loaded (§8, §16, §17).
 *
 * Both must agree, or one would undo the other's answer.
 */
export interface ResidencyContext {
  /**
   * Served model ids on *this same runtime* that another entry is keeping
   * resident (§8), as that entry's own adapter spells them.
   *
   * A multi-model adapter enforces residency by unloading everything that is not
   * its target; these are what it must leave alone. Absent or empty means the
   * old rule — the target and nothing else.
   *
   * Core never populates it with an id from a different runtime: LM Studio
   * answers to a gateway-assigned `--identifier` and oMLX to a backend model
   * name, so a foreign id would either match nothing or, worse, the wrong thing.
   */
  readonly keepLoaded?: readonly string[];
}

export interface AcquireOptions extends WaitOptions, ResidencyContext {}

export interface OptionValidationContext {
  /** Logical model id, for error messages. */
  readonly id: string;
  /** The `runtimes:` key this model resolves through, for error messages. */
  readonly runtimeId: string;
  /** The whole `models:` entry, so an adapter can cross-check fields it owns. */
  readonly entry: Readonly<Record<string, unknown>>;
  /**
   * The whole `runtimes:` entry. The custom adapter's `process`/`health`/
   * `model_discovery`/`endpoint` blocks live here, so this is what it parses.
   */
  readonly runtimeEntry: Readonly<Record<string, unknown>>;
}
