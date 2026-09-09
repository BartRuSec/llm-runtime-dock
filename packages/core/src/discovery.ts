import { Document, isMap, parseDocument, stringify, type YAMLMap } from 'yaml';
import type { RuntimeAdapter } from './adapter.js';
import { configWriteTarget, type ConfigLocation } from './config/paths.js';
import { cliError } from './errors.js';
import { backupFile, readTextIfExists, writeTextFile } from './fs-utils.js';
import type { Logger } from './logging.js';
import { nullLogger } from './logging.js';
import type { DiscoveredModel, ProbeResult, ProbeTarget } from './types.js';

/**
 * Runtime discovery (spec §22).
 *
 * Probing is runtime-specific, so it lives in the adapter. Core only decides
 * which adapters to ask, merges their answers and, on an explicit flag, writes
 * configuration.
 */

export interface AdapterProbeOutcome {
  readonly adapter: string;
  /**
   * The `runtimes:` key this probe speaks for (§12, §22). A declared runtime's
   * own key, or the adapter id when nothing is declared yet — which is also the
   * key `--save` creates.
   *
   * Ownership and staleness are scoped to this rather than to `adapter`: two
   * declared runtimes on one adapter must not make each other's models stale.
   */
  readonly runtimeId: string;
  readonly result: ProbeResult;
  /** Ids that were skipped because they are not safe to write (§22). */
  readonly skipped: readonly { id: string; reason: string }[];
}

export type IdCheck = { ok: true } | { ok: false; reason: string };

/**
 * Conservative character set for a config **key** — the logical model id a
 * client sends. A rewritten id no longer matches what the runtime serves, so
 * invalid ids are skipped, never sanitized.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._@:+-]*$/;

export const validateDiscoveredId = (id: string): IdCheck => {
  if (id.length === 0) return { ok: false, reason: 'empty id' };
  if (id.startsWith('-')) {
    return { ok: false, reason: 'begins with "-" and could be read as a command-line flag' };
  }
  if (id.length > 200) return { ok: false, reason: 'longer than 200 characters' };
  if (!SAFE_KEY.test(id)) {
    return { ok: false, reason: 'contains characters outside [A-Za-z0-9._@:+-]' };
  }
  return { ok: true };
};

/**
 * A configuration key for a served model id that is not usable as one.
 *
 * `google/gemma-4-26b-a4b-qat` → `google-gemma-4-26b-a4b-qat`. The separator is
 * flattened, never dropped: several publishers ship the same weights, and
 * `google/gemma-4`, `lmstudio-community/gemma-4` and `bartowski/gemma-4` must
 * not collapse onto one key. (Flattening makes that unlikely, not impossible —
 * `a/b-c` and `a-b/c` both give `a-b-c` — but both forms are contrived for a
 * real repo id.)
 *
 * An id that is already a valid key is returned byte for byte, because renaming
 * one that works would change what clients send for no reason. Only a derived
 * key is lowercased, so `GPT-4o` survives as itself while `Qwen/Qwen3-72B`
 * becomes `qwen-qwen3-72b`. This names the entry a human is about to review; it
 * is never matched against anything the runtime reports, so it is safe to
 * derive. `backend_model` keeps the id the server actually gave (§22).
 *
 * MTPLX has its own `suggestLogicalId`, which drops the owner segment. That is
 * deliberate history — changing it would rename keys in configurations already
 * written — not a second implementation of this.
 */
export const suggestKeyForServedId = (servedId: string): string => {
  if (validateDiscoveredId(servedId).ok) return servedId;
  const derived = servedId
    .replace(/[^A-Za-z0-9._@:+-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  // Defensive: nothing that reaches the key check can derive to an empty
  // string, since `validateBackendModelRef` runs first and demands an
  // alphanumeric first character, which flattening never replaces.
  return derived === '' ? servedId : derived;
};

/**
 * The same question for a `backend_model` value, which is looser: it is a
 * reference the runtime understands, and a Hugging Face repo id legitimately
 * contains `/`. It still reaches a launch command as `--model <value>`, so the
 * constraints that matter are kept — nothing that reads as a flag, no
 * whitespace, no control characters, no path traversal.
 */
export const validateBackendModelRef = (ref: string): IdCheck => {
  if (ref.length === 0) return { ok: false, reason: 'empty model reference' };
  if (ref.startsWith('-')) {
    return { ok: false, reason: 'begins with "-" and could be read as a command-line flag' };
  }
  if (ref.length > 300) return { ok: false, reason: 'longer than 300 characters' };
  // Matching control characters is the point: this value reaches an argv.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(ref)) {
    return { ok: false, reason: 'contains whitespace or control characters' };
  }
  if (ref.split('/').includes('..')) {
    return { ok: false, reason: 'contains a ".." path segment' };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:+\-/\\]*$/.test(ref)) {
    return { ok: false, reason: 'contains characters outside [A-Za-z0-9._@:+-/]' };
  }
  return { ok: true };
};

export interface ProbeOptions {
  /** The `runtimes:` key this probe speaks for. Defaults to the adapter id. */
  readonly runtimeId?: string;
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * Where a probe looks, stated once (§22):
 *
 * ```text
 * --url > --host/--port > the runtimes: entry > adapter.defaultProbeTarget > error
 * ```
 *
 * The caller resolves a declared runtime into `host`/`port` before calling, so
 * this only has to compose an explicit half with the adapter's default for the
 * other one — `--port 8001` on loopback must not need a `--host` too.
 */
export const resolveProbeUrl = (
  adapter: RuntimeAdapter,
  options: Pick<ProbeOptions, 'url' | 'host' | 'port'>,
): string => {
  if (options.url) return options.url;

  const fallback = adapter.defaultProbeTarget;
  if (fallback === null && options.port === undefined) {
    throw cliError('CONFIG_INVALID', `the ${adapter.id} adapter has no default probe target`, {
      details: { adapter: adapter.id },
      hint: `pass --url, e.g. \`lrd probe ${adapter.id} --url=http://127.0.0.1:8000\``,
    });
  }
  const base = fallback === null ? new URL('http://127.0.0.1') : new URL(fallback);
  if (options.host) base.hostname = options.host;
  if (options.port !== undefined) base.port = String(options.port);
  // `new URL(...).toString()` appends a trailing slash to a bare origin, which
  // then doubles up in `joinUrl`. The origin is what every adapter joins onto.
  return base.pathname === '/' ? base.origin : base.toString();
};

/** Probe one adapter and filter out ids that must not be written to config. */
export const probeAdapter = async (
  adapter: RuntimeAdapter,
  options: ProbeOptions = {},
): Promise<AdapterProbeOutcome> => {
  const logger = options.logger ?? nullLogger;
  const runtimeId = options.runtimeId ?? adapter.id;
  const url = resolveProbeUrl(adapter, options);
  const target: ProbeTarget = { url, apiKey: options.apiKey, timeoutMs: options.timeoutMs };
  let result: ProbeResult;
  try {
    result = await adapter.probe(target);
  } catch (error) {
    // "Not running" is an answer, not an error (§22).
    result = { status: 'not_running', url: target.url, detail: (error as Error).message };
  }

  logger.debug('probe finished', {
    event: 'probe.result',
    adapter: adapter.id,
    runtime: runtimeId,
    status: result.status,
  });

  // Nothing to filter: none of these three carry a model list.
  if (
    result.status === 'auth_required' ||
    result.status === 'not_installed' ||
    result.status === 'foreign_server'
  ) {
    return { adapter: adapter.id, runtimeId, result, skipped: [] };
  }

  const skipped: { id: string; reason: string }[] = [];
  /**
   * Each id is checked against the rule for the field it lands in: the config
   * key must be a plain logical id, the backend reference only has to be safe
   * as an argv value. Checking one against both would drop every repo id.
   */
  const filter = (models: readonly DiscoveredModel[] | undefined): DiscoveredModel[] => {
    const kept: DiscoveredModel[] = [];
    for (const model of models ?? []) {
      if (model.unusable) {
        // The runtime lists it but says it cannot serve it. Skipping and saying
        // why beats writing an entry that fails on its first switch.
        skipped.push({ id: model.id, reason: model.unusable });
        continue;
      }
      const ref = validateBackendModelRef(model.id);
      if (!ref.ok) {
        skipped.push({ id: model.id, reason: ref.reason });
        continue;
      }
      const key = validateDiscoveredId(model.suggestedId ?? model.id);
      if (!key.ok) {
        skipped.push({ id: model.suggestedId ?? model.id, reason: key.reason });
        continue;
      }
      kept.push(model);
    }
    return kept;
  };

  if (result.status === 'not_running') {
    const available = filter(result.available);
    return {
      adapter: adapter.id,
      runtimeId,
      result: available.length > 0 ? { ...result, available } : result,
      skipped,
    };
  }

  const models = filter(result.models);
  const available = filter(result.available);
  return {
    adapter: adapter.id,
    runtimeId,
    result: {
      status: 'running',
      url: result.url,
      models,
      ...(available.length > 0 ? { available } : {}),
    },
    skipped,
  };
};

export interface SavePlanConflict {
  readonly id: string;
  readonly reason: string;
}

/** One runtime's offer of a model key, while a save works out who owns it. */
interface ModelCandidate {
  readonly runtimeId: string;
  readonly adapter: string;
  readonly backendModel: string;
}

/** A configured model of a probed runtime that the probe did not report. */
export interface StaleEntry {
  readonly id: string;
  readonly adapter: string;
  readonly runtime: string;
}

/** A model that belongs to no declared runtime, and why (§22). */
export interface UnownedEntry {
  readonly id: string;
  readonly reason: string;
}

/**
 * A rediscovered model that already belongs to a runtime other than the one that
 * found it (§22).
 *
 * Not a collision: it has an owner, so discovery has nothing to add. Reported
 * rather than written, because silently moving a configured model to whichever
 * server happened to list it is the one thing saving must never do.
 */
export interface RetainedEntry {
  readonly id: string;
  /** The runtime it stays on. */
  readonly runtime: string;
}

/**
 * A model nothing owns yet that several runtimes of one adapter all offer (§22).
 *
 * A catalogue-based adapter reports the same catalogue from every one of its
 * servers — `mtplx models` does not know which port asked — so the probe cannot
 * say which runtime should serve it. The caller resolves it and hands the answer
 * back through `assign`, exactly as it does for `remove`.
 */
export interface AmbiguousEntry {
  readonly id: string;
  readonly adapter: string;
  /** Runtime keys that offered it, in configuration order. */
  readonly candidates: readonly string[];
}

/** Keys touched in each of the two sections a save writes. */
export interface SectionKeys {
  readonly runtimes: readonly string[];
  readonly models: readonly string[];
}

export interface SaveDiscoveryOptions {
  readonly outcomes: readonly AdapterProbeOutcome[];
  readonly location: ConfigLocation;
  readonly defaultServer?: { host: string; port: number };
  /** Compute the plan and report conflicts without writing. */
  readonly dryRun?: boolean;
  /**
   * Stale ids the caller approved for deletion (§22). Deleting a configured
   * model is the one destructive thing saving does, so it is never inferred:
   * core reports `stale`, and the caller — a prompt, or `--force` — decides.
   * Anything not named here survives the save untouched.
   */
  readonly remove?: readonly string[];
  /**
   * Which runtime owns an ambiguous id, keyed by model id (§22). The mirror of
   * `remove`: core reports `ambiguous`, the caller — a prompt — decides, and the
   * answer comes back here. A value naming a runtime that did not offer the
   * model is ignored rather than trusted.
   */
  readonly assign?: Readonly<Record<string, string>>;
  readonly logger?: Logger;
}

export interface SaveDiscoveryResult {
  readonly path: string;
  readonly content: string;
  readonly backup: string | null;
  readonly written: boolean;
  /** Keys that did not exist before. */
  readonly added: SectionKeys;
  /**
   * Keys that already existed and were rediscovered: the fields discovery owns
   * were refreshed, every other key the user wrote was left alone.
   */
  readonly updated: SectionKeys;
  /** Models of a probed runtime the probe did not report, decided or not. */
  readonly stale: readonly StaleEntry[];
  /** The subset of `stale` that `remove` approved, and that was deleted. */
  readonly removed: readonly string[];
  /**
   * Models that belong to nobody: no `runtime:` key, or one naming a runtime
   * that is not declared. Replacement cannot touch them and `loadConfig` rejects
   * them, so they are reported rather than left to break every other command.
   */
  readonly unowned: readonly UnownedEntry[];
  /** Rediscovered models left on the runtime that already owned them. */
  readonly retained: readonly RetainedEntry[];
  /** Unowned models several runtimes of one adapter offered, and nobody resolved. */
  readonly ambiguous: readonly AmbiguousEntry[];
}

/**
 * Turn probe results into configuration (§22).
 *
 * Two sections are written. `runtimes:` gets the endpoint that answered;
 * `models:` gets what it serves, each naming its runtime. A rediscovered entry
 * keeps everything the user wrote on it — only the fields discovery owns
 * (`adapter`, `host`, `port` on a runtime; `runtime`, `backend_model` on a
 * model) are refreshed. A model of a probed runtime that the probe did not
 * report is reported as `stale` and removed only when `remove` names it.
 * Entries belonging to other runtimes are untouched. Name collisions fail rather
 * than resolve themselves, and a dry run performs exactly the same check.
 *
 * A runtime entry is never removed. Saving may delete a *model* the user
 * approved, and nothing else: a declared runtime whose backend is merely off is
 * the normal state of a laptop, and `doctor` reports one with no models as a
 * warning rather than something to clean up.
 */
export const saveDiscovery = (options: SaveDiscoveryOptions): SaveDiscoveryResult => {
  const logger = options.logger ?? nullLogger;
  const path = configWriteTarget(options.location);
  const existingText = readTextIfExists(path);

  const doc =
    existingText === null ? newConfigDocument(options.defaultServer) : parseDocument(existingText);
  if (doc.errors.length > 0) {
    throw cliError('CONFIG_INVALID', `${path}: ${doc.errors[0]?.message ?? 'invalid YAML'}`, {
      details: { path },
    });
  }

  const runtimes = requireMap(doc, path, 'runtimes');
  const models = requireMap(doc, path, 'models');

  // A runtime counts as probed once it reported anything to configure — a
  // runtime whose server is down but whose models are installed locally is the
  // normal case for a single-model runtime, and is exactly what needs writing.
  const probedRuntimes = new Set(
    options.outcomes.filter((o) => discoveredModels(o).length > 0).map((o) => o.runtimeId),
  );

  // Existing models, by id, with the runtime key that owns them. `''` means the
  // entry declares no runtime at all.
  const existingOwner = new Map<string, string>();
  for (const item of models.items) {
    const value = item.value;
    existingOwner.set(String(item.key), isMap(value) ? String(value.get('runtime') ?? '') : '');
  }
  const declaredRuntimes = new Set(runtimes.items.map((item) => String(item.key)));

  const conflicts: SavePlanConflict[] = [];
  const claimed = new Map<string, string>();
  const runtimeAdditions: RuntimeAddition[] = [];
  const modelAdditions: ModelAddition[] = [];

  const retained: RetainedEntry[] = [];
  const ambiguous: AmbiguousEntry[] = [];

  // Pass 1: who offered what. The candidate list is only complete once every
  // outcome has been seen — a third runtime may follow the second — so nothing
  // can be decided while walking them.
  const candidates = new Map<string, ModelCandidate[]>();
  for (const outcome of options.outcomes) {
    // A runtime that is not installed, or whose port is answered by something
    // else, has no endpoint worth recording: writing one would point this
    // runtime at a server that is not its own, and the first switch would fail.
    if (writesRuntimeEntry(outcome)) {
      runtimeAdditions.push({
        key: outcome.runtimeId,
        adapter: outcome.adapter,
        url: outcome.result.url,
      });
    }

    for (const model of discoveredModels(outcome)) {
      // The config key and the backend reference are different things once a
      // runtime names models by repo id; ownership is about the key.
      const key = model.suggestedId ?? model.id;
      const list = candidates.get(key) ?? [];
      if (!list.some((candidate) => candidate.runtimeId === outcome.runtimeId)) {
        list.push({
          runtimeId: outcome.runtimeId,
          adapter: outcome.adapter,
          backendModel: model.id,
        });
      }
      candidates.set(key, list);
    }
  }

  // Pass 2: decide. Existing ownership is settled *first*, before anything about
  // who else offered the id. A catalogue-based adapter reports the same
  // catalogue from every one of its servers, so a model already assigned to one
  // of them would otherwise look like a collision with itself (§22).
  for (const [key, offered] of candidates) {
    const owner = existingOwner.get(key);
    // `''` means the entry declares no runtime. It is nobody's property, so
    // rewriting the key is a repair rather than a collision.
    if (owner !== undefined && owner !== '') {
      const claimant = offered.find((candidate) => candidate.runtimeId === owner);
      if (claimant) {
        claimed.set(key, owner);
        modelAdditions.push({ key, runtimeId: owner, backendModel: claimant.backendModel });
        continue;
      }
      // Owned by a runtime that did not offer it this run — or offered only by
      // its siblings. Either way it has an owner, so it stays there.
      //
      // Claiming it is load-bearing, not bookkeeping: the staleness loop below
      // skips claimed ids, and without this a model whose owner is also being
      // probed would be offered for deletion on the strength of a sibling
      // rediscovering it.
      retained.push({ id: key, runtime: owner });
      claimed.set(key, owner);
      continue;
    }

    const chosen =
      offered.length === 1
        ? offered[0]
        : offered.find((candidate) => candidate.runtimeId === options.assign?.[key]);
    if (chosen) {
      claimed.set(key, chosen.runtimeId);
      modelAdditions.push({
        key,
        runtimeId: chosen.runtimeId,
        backendModel: chosen.backendModel,
      });
      continue;
    }

    // Nobody owns it and several runtimes offer it. Within one adapter that is a
    // question with an answer the user has, so it is asked rather than failed.
    // Across adapters it is the collision §22 exists for — two backends serving
    // genuinely different weights under one name — and no prompt scoped to a
    // single adapter could resolve it.
    const adapters = new Set(offered.map((candidate) => candidate.adapter));
    const runtimeIds = offered.map((candidate) => candidate.runtimeId);
    if (adapters.size === 1) {
      ambiguous.push({ id: key, adapter: offered[0]!.adapter, candidates: runtimeIds });
      continue;
    }
    conflicts.push({ id: key, reason: `discovered by ${runtimeIds.join(' and ')}` });
  }

  if (conflicts.length > 0) {
    throw cliError(
      'DISCOVERY_NAME_CONFLICT',
      `discovered model ids collide; configuration left untouched:\n${conflicts
        .map((c) => `  ${c.id}: ${c.reason}`)
        .join('\n')}`,
      {
        details: { path, conflicts: conflicts.map((c) => c.id) },
        hint: 'these are different backends serving one name — rename one of the entries by hand',
      },
    );
  }

  // What this runtime has configured but the probe did not report. Removing it
  // is the caller's call, not an inference: `remove` names what may go.
  const approved = new Set(options.remove ?? []);
  const willDeclare = new Set(runtimeAdditions.map((addition) => addition.key));
  const stale: StaleEntry[] = [];
  const removed: string[] = [];
  const unowned: UnownedEntry[] = [];
  const adapterOf = new Map(options.outcomes.map((o) => [o.runtimeId, o.adapter]));

  for (const [id, runtimeId] of existingOwner) {
    if (runtimeId === '') {
      // Nothing claims it, so nothing may delete it either — but it is invalid
      // configuration and the caller has to hear about it.
      if (!claimed.has(id)) unowned.push({ id, reason: 'names no runtime' });
      continue;
    }
    if (!declaredRuntimes.has(runtimeId) && !willDeclare.has(runtimeId)) {
      unowned.push({ id, reason: `names undeclared runtime "${runtimeId}"` });
      continue;
    }
    if (!probedRuntimes.has(runtimeId)) continue;
    if (claimed.has(id)) continue;
    stale.push({ id, adapter: adapterOf.get(runtimeId) ?? '', runtime: runtimeId });
    if (approved.has(id)) {
      removeEntry(models, id);
      removed.push(id);
    }
  }

  const added: { runtimes: string[]; models: string[] } = { runtimes: [], models: [] };
  const updated: { runtimes: string[]; models: string[] } = { runtimes: [], models: [] };

  for (const addition of runtimeAdditions) {
    const current = runtimes.get(addition.key);
    if (isMap(current)) {
      refreshRuntimeEntry(doc, current, addition);
      updated.runtimes.push(addition.key);
      continue;
    }
    runtimes.set(doc.createNode(addition.key), doc.createNode(discoveredRuntimeEntry(addition)));
    added.runtimes.push(addition.key);
  }

  for (const addition of modelAdditions) {
    const current = models.get(addition.key);
    if (isMap(current)) {
      // Mutating in place, rather than delete-then-set: the entry keeps its
      // position, its comments, and every option the user put on it.
      refreshModelEntry(doc, current, addition);
      updated.models.push(addition.key);
      continue;
    }
    models.set(doc.createNode(addition.key), doc.createNode(discoveredModelEntry(addition)));
    added.models.push(addition.key);
  }

  const content = doc.toString({ lineWidth: 0 });
  if (options.dryRun) {
    return {
      path,
      content,
      backup: null,
      written: false,
      added,
      updated,
      stale,
      removed,
      unowned,
      retained,
      ambiguous,
    };
  }

  logger.info('writing configuration', { event: 'config.write', path });
  const backup = backupFile(path);
  writeTextFile(path, content);
  return {
    path,
    content,
    backup,
    written: true,
    added,
    updated,
    stale,
    removed,
    unowned,
    retained,
    ambiguous,
  };
};

/**
 * Does this outcome warrant a `runtimes:` entry?
 *
 * "Not running" does: the port is free and it is this runtime's conventional
 * endpoint, which is exactly the runtime a user wants recorded so the gateway
 * can start it later. "Not installed" and "not this runtime" do not.
 */
const writesRuntimeEntry = (outcome: AdapterProbeOutcome): boolean => {
  return outcome.result.status !== 'not_installed' && outcome.result.status !== 'foreign_server';
};

/** Get a top-level mapping, creating it when the file has none. */
const requireMap = (doc: Document, path: string, key: string): YAMLMap => {
  let node = doc.get(key);
  if (!isMap(node)) {
    doc.set(key, doc.createNode({}));
    node = doc.get(key);
  }
  if (!isMap(node)) {
    throw cliError('CONFIG_INVALID', `${path}: "${key}" is not a mapping`);
  }
  return node;
};

/** One planned `runtimes:` entry: the key it gets, and the endpoint that answered. */
interface RuntimeAddition {
  readonly key: string;
  readonly adapter: string;
  readonly url: string;
}

/** One planned `models:` entry: the key it gets, and the reference the runtime understands. */
interface ModelAddition {
  readonly key: string;
  readonly runtimeId: string;
  readonly backendModel: string;
}

/**
 * Every model an outcome offers for configuration.
 *
 * An adapter that reports an installed catalogue has already answered the
 * question configuration asks — *what can this machine be told to serve* — and
 * answered it in the reference the runtime accepts on a launch command. What a
 * running server happens to have loaded is a different question, and for a
 * single-model runtime the answer is one model that is in the catalogue anyway.
 *
 * The two are not even named alike: MTPLX loads `Youssofal/Qwen3.6-…-Balance`
 * and then serves it under the id `mtplx-qwen36-…-balance`. Taking both lists
 * wrote that model twice, the second time under a reference `mtplx serve
 * --model` does not accept. So the catalogue wins where there is one; the served
 * list stays what it is good for, which is telling the user what is loaded (§22).
 */
const discoveredModels = (outcome: AdapterProbeOutcome): DiscoveredModel[] => {
  const result = outcome.result;
  if (
    result.status === 'auth_required' ||
    result.status === 'not_installed' ||
    result.status === 'foreign_server'
  ) {
    return [];
  }
  const available = result.available ?? [];
  const source =
    available.length > 0 ? available : result.status === 'running' ? result.models : [];
  const merged = new Map<string, DiscoveredModel>();
  for (const model of source) {
    if (!merged.has(model.id)) merged.set(model.id, model);
  }
  return [...merged.values()];
};

/**
 * One `runtimes:` entry built from what answered. Shared by `--save` and the
 * preview a bare probe prints, so the two can never drift.
 */
const discoveredRuntimeEntry = (addition: RuntimeAddition): Record<string, unknown> => {
  const url = new URL(addition.url);
  const entry: Record<string, unknown> = { adapter: addition.adapter };
  if (url.hostname && url.hostname !== '127.0.0.1') entry.host = url.hostname;
  if (url.port) entry.port = Number(url.port);
  return entry;
};

/** One `models:` entry built from a discovered model. */
const discoveredModelEntry = (addition: ModelAddition): Record<string, unknown> => {
  return { runtime: addition.runtimeId, backend_model: addition.backendModel };
};

/**
 * Delete one entry without leaving its comment behind on the next one.
 *
 * `yaml` stores a comment written above the *first* entry on the map itself
 * rather than on that entry's key, so a plain `delete` re-attaches it to
 * whatever becomes first — possibly an entry of another adapter, which this
 * save promised not to touch. Every other entry carries its own comment and
 * deletes cleanly.
 *
 * A comment directly under `models:` reads two ways — about the block, or about
 * the entry below it — and nothing in the file distinguishes them. Taking it as
 * the entry's is what a person deleting that entry by hand would do, and the
 * backup is the recourse if it was the other one.
 */
const removeEntry = (models: YAMLMap, id: string): void => {
  if (String(models.items[0]?.key) === id) models.commentBefore = undefined;
  models.delete(id);
};

/**
 * Refresh the fields discovery owns on a runtime entry that already exists, and
 * only those. `host` and `port` are written conditionally, so a value the probe does
 * not warrant has to be deleted rather than left: refreshing the port while
 * keeping a `host:` from an earlier probe would point the entry at an endpoint
 * nothing answered. A field whose value is already right is not rewritten, so
 * its comment and formatting survive too.
 */
const refreshRuntimeEntry = (doc: Document, node: YAMLMap, addition: RuntimeAddition): void => {
  const fields = discoveredRuntimeEntry(addition);
  for (const [key, value] of Object.entries(fields)) {
    if (node.get(key) !== value) node.set(key, doc.createNode(value));
  }
  for (const key of ['host', 'port']) {
    if (!(key in fields)) node.delete(key);
  }
};

/**
 * The same for a model entry — but a model's two owned fields are
 * unconditional, so this never deletes anything. Sharing the loop above would
 * strip `runtime:` the moment a refresh did not produce it, turning a valid
 * entry into an unowned one.
 */
const refreshModelEntry = (doc: Document, node: YAMLMap, addition: ModelAddition): void => {
  for (const [key, value] of Object.entries(discoveredModelEntry(addition))) {
    if (node.get(key) !== value) node.set(key, doc.createNode(value));
  }
};

export interface DiscoveryPreview {
  /** The `runtimes:` and `models:` blocks, as YAML, in that order. */
  readonly yaml: string;
  /** Discovered model keys. May be empty while `yaml` still holds a runtime. */
  readonly ids: readonly string[];
  /**
   * Ids nothing owns yet that several runtimes offered, so the preview had to
   * pick one. A bare probe is read-only and must not fail, so it reports them
   * instead of throwing (§22).
   *
   * An id that is *already* configured is not here: it has an owner, the preview
   * renders it under that owner, and saving leaves it alone.
   */
  readonly collisions: readonly string[];
}

/**
 * Render what a probe found as configuration, without touching any file.
 *
 * This is what a bare `lrd probe` prints so the result is usable by hand:
 * discovery exists to *produce* configuration, and seeing it is most of the
 * point. Returns `null` when nothing was discovered.
 */
export const renderDiscoveredModels = (
  outcomes: readonly AdapterProbeOutcome[],
  /**
   * Who already owns each model id, from the configuration on disk. Without it
   * the preview would render an id under whichever runtime happened to be probed
   * first, contradicting both the current config and what `--save` would do.
   */
  existingOwners?: ReadonlyMap<string, string>,
): DiscoveryPreview | null => {
  const runtimes: Record<string, unknown> = {};
  const models: Record<string, unknown> = {};
  const ids: string[] = [];
  const collisions: string[] = [];
  const claimedBy = new Map<string, string>();

  for (const outcome of outcomes) {
    const discovered = discoveredModels(outcome);
    // Exactly the condition `saveDiscovery` uses. A runtime with no models under
    // it is the common first-run case — a backend that is simply down — and
    // `--save` records it, so the preview has to show it or the two drift.
    if (writesRuntimeEntry(outcome)) {
      runtimes[outcome.runtimeId] = discoveredRuntimeEntry({
        key: outcome.runtimeId,
        adapter: outcome.adapter,
        url: outcome.result.url,
      });
    }
    for (const model of discovered) {
      const key = model.suggestedId ?? model.id;
      // An existing owner settles it, exactly as in `saveDiscovery`: the entry is
      // rendered where it already lives, and a sibling runtime rediscovering it
      // is not a collision.
      const owner = existingOwners?.get(key);
      const runtimeId = owner !== undefined && owner !== '' ? owner : outcome.runtimeId;
      const previous = claimedBy.get(key);
      if (previous !== undefined) {
        if (previous !== runtimeId && !collisions.includes(key)) collisions.push(key);
        continue;
      }
      claimedBy.set(key, runtimeId);
      models[key] = discoveredModelEntry({ key, runtimeId, backendModel: model.id });
      ids.push(key);
    }
  }

  // A runtime on its own is still configuration worth printing: it is the
  // endpoint the gateway needs in order to start that backend later.
  if (ids.length === 0 && Object.keys(runtimes).length === 0) return null;
  return { yaml: stringify({ runtimes, models }, { lineWidth: 0 }).trimEnd(), ids, collisions };
};

const newConfigDocument = (server: { host: string; port: number } | undefined): Document => {
  const doc = new Document({
    server: { host: server?.host ?? '127.0.0.1', port: server?.port ?? 8787 },
    runtimes: {},
    models: {},
  });
  return doc;
};
