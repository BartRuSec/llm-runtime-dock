import type { RuntimeAdapter } from './adapter.js';
import { gatewayError, isGatewayError } from './errors.js';
import type { GatewayError } from './errors.js';
import type { Logger } from './logging.js';
import { nullLogger } from './logging.js';
import type { AdapterRegistry } from './registry.js';
import type { ModelRelease, RuntimeInstance, RuntimeState, ServerOwnership } from './types.js';

/**
 * The scheduler owns the resident slot (spec §8, §24).
 *
 * Two things are tracked, and keeping them apart is the whole design:
 *
 * - **the loaded set** — memory. One *rotating* occupant, plus any entry that
 *   opted in with `keep_resident`. A kept entry is never released by a switch,
 *   and switching to or from one releases nothing either: that second half is
 *   what makes the flag useful, since otherwise reaching the kept model would
 *   still evict the model the user was working with.
 * - **the serving token** — exactly one entry answers at a time. A single
 *   machine has one GPU, so residency is not concurrency.
 *
 * Every grant goes through one FIFO queue processed by a single pump. That is
 * what serializes switching — two simultaneous requests cannot trigger two
 * acquire/release cycles, and a warm request cannot slip in while the occupant
 * is draining, because the pump is the only thing that hands out leases.
 */

export interface Lease {
  readonly runtime: RuntimeInstance;
  readonly adapter: RuntimeAdapter;
  /** Must be called exactly once, when the request (including its stream) ends. */
  release(): void;
}

export interface SchedulerOptions {
  readonly registry: AdapterRegistry;
  readonly logger?: Logger;
  /** How long to wait for a runtime to become ready. */
  readonly readyTimeoutMs?: number;
  /** How long to wait for active requests to finish before a switch. */
  readonly drainTimeoutMs?: number;
}

export interface ResidentStatus {
  readonly modelId: string;
  readonly adapter: string;
  readonly backendModel: string;
  readonly state: RuntimeState;
  readonly ownership: ServerOwnership;
  readonly modelRelease: ModelRelease;
  readonly activeRequests: number;
  readonly since: string;
}

export interface SchedulerStatus {
  /** The rotating occupant: the one entry a switch is allowed to release. */
  readonly resident: ResidentStatus | null;
  /**
   * Entries held in memory by `keep_resident` (§8). With more than one model
   * loaded, a single row can no longer say where the memory went.
   */
  readonly kept: readonly ResidentStatus[];
  /** Which loaded entry currently holds the serving token. */
  readonly serving: string | null;
  readonly queueDepth: number;
  readonly switching: string | null;
  /** How the previous occupant was released, for observability (§26). */
  readonly lastRelease: { readonly modelId: string; readonly via: ModelRelease } | null;
}

interface Slot {
  instance: RuntimeInstance;
  adapter: RuntimeAdapter;
  state: RuntimeState;
  ownership: ServerOwnership;
  leases: number;
  since: number;
}

interface Waiter {
  readonly instance: RuntimeInstance;
  readonly requestId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (lease: Lease) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  onAbort?: () => void;
}

const DEFAULT_READY_TIMEOUT_MS = 300_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 600_000;

export interface Scheduler {
  status(): SchedulerStatus;
  /**
   * Acquire the slot for `instance` and hold it for one request. The caller must
   * release the lease when the request — including its stream — has ended.
   */
  acquire(
    instance: RuntimeInstance,
    options?: { signal?: AbortSignal; requestId?: string },
  ): Promise<Lease>;
  /**
   * `POST /switch` and `lrd switch`: make an entry resident through the same
   * path a request-triggered switch takes (§14). It is not a shortcut into the
   * adapter — it drains, releases and acquires like everything else.
   */
  switchTo(instance: RuntimeInstance, options?: { requestId?: string }): Promise<void>;
  /**
   * An upstream that stopped answering invalidates readiness. The next acquire
   * for this entry re-runs the full start/verify path rather than proxying into
   * a dead process.
   */
  reportUpstreamFailure(modelId: string, reason: string): void;
  /** Release the slot and stop everything. Used on gateway shutdown. */
  shutdown(): Promise<void>;
}

export const createScheduler = (options: SchedulerOptions): Scheduler => {
  const registry = options.registry;
  const logger = options.logger ?? nullLogger;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  /** The rotating occupant: the only slot a switch may release. */
  let resident: Slot | null = null;
  /** Loaded and never released by a switch, keyed by entry id (§8). */
  const kept = new Map<string, Slot>();
  /**
   * Which loaded slot holds the serving token.
   *
   * A pointer, not a refcount: it stays put when the last lease drops, which is
   * what makes returning to a model already in memory instant.
   */
  let serving: Slot | null = null;
  const waiters: Waiter[] = [];
  /**
   * Waiters not yet settled, including the one the pump is currently serving.
   * `waiters.length` alone would report zero during a switch, which is exactly
   * when the queue matters.
   */
  let pending = 0;
  let pumping = false;
  let switching: string | null = null;
  let lastRelease: { modelId: string; via: ModelRelease } | null = null;
  /** Resolvers woken when the active lease count reaches zero. */
  let drainWaiters: Array<() => void> = [];

  const describe = (slot: Slot): ResidentStatus => ({
    modelId: slot.instance.id,
    adapter: slot.adapter.id,
    backendModel: slot.instance.backendModel,
    state: slot.state,
    ownership: slot.ownership,
    modelRelease: slot.adapter.modelRelease,
    activeRequests: slot.leases,
    since: new Date(slot.since).toISOString(),
  });

  const status = (): SchedulerStatus => {
    return {
      resident: resident ? describe(resident) : null,
      kept: [...kept.values()].map(describe),
      serving: serving ? serving.instance.id : null,
      queueDepth: pending,
      switching: switching,
      lastRelease: lastRelease,
    };
  };

  /** The loaded slot for an entry id, rotating or kept. */
  const slotFor = (modelId: string): Slot | undefined => {
    if (resident?.instance.id === modelId) return resident;
    return kept.get(modelId);
  };

  /**
   * Served ids on `instance`'s own runtime that another entry keeps resident.
   *
   * Filtered by `runtimeId` because these are the ids that runtime answers to:
   * LM Studio's gateway-assigned `--identifier`, oMLX's backend model name. An
   * id from a different runtime would match nothing, or the wrong thing.
   */
  const keepLoadedFor = (instance: RuntimeInstance): string[] =>
    [...kept.values()]
      .filter(
        (slot) =>
          slot.instance.id !== instance.id && slot.instance.runtimeId === instance.runtimeId,
      )
      .map((slot) => slot.adapter.servedModelId(slot.instance));

  /**
   * Acquire the slot for `instance` and hold it for one request. The caller must
   * release the lease when the request — including its stream — has ended.
   */
  const acquire = (
    instance: RuntimeInstance,
    options: { signal?: AbortSignal; requestId?: string } = {},
  ): Promise<Lease> => {
    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = {
        instance,
        requestId: options.requestId,
        signal: options.signal,
        resolve,
        reject,
        settled: false,
      };
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (options.signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return;
          const index = waiters.indexOf(waiter);
          // Only drop a waiter that is still queued; one already being served by
          // the pump is settled there.
          if (index >= 0) {
            waiters.splice(index, 1);
            waiter.settled = true;
            pending -= 1;
            waiter.reject(abortError());
          }
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
      pending += 1;
      logger.debug('queued for the resident slot', {
        event: 'slot.queue',
        runtime: instance.id,
        requestId: options.requestId,
        queueDepth: pending,
      });
      void pump();
    });
  };

  /**
   * `POST /switch` and `lrd switch`: make an entry resident through the same
   * path a request-triggered switch takes (§14). It is not a shortcut into the
   * adapter — it drains, releases and acquires like everything else.
   */
  const switchTo = async (
    instance: RuntimeInstance,
    options: { requestId?: string } = {},
  ): Promise<void> => {
    const lease = await acquire(instance, options);
    lease.release();
  };

  /**
   * An upstream that stopped answering invalidates readiness. The next acquire
   * for this entry re-runs the full start/verify path rather than proxying into
   * a dead process.
   */
  const reportUpstreamFailure = (modelId: string, reason: string): void => {
    // Kept entries are checked too: one whose server died must not be proxied
    // into on its next turn just because nothing ever released it.
    const slot = slotFor(modelId);
    if (!slot) return;
    slot.state = 'failed';
    logger.warn('runtime marked failed after an upstream failure', {
      event: 'runtime.failed',
      runtime: modelId,
      adapter: slot.adapter.id,
      error: reason,
    });
  };

  /** Release the slot and stop everything. Used on gateway shutdown. */
  const shutdown = async (): Promise<void> => {
    for (const waiter of waiters.splice(0)) {
      waiter.settled = true;
      pending -= 1;
      waiter.reject(gatewayError('RUNTIME_SLOT_BUSY', 'gateway is shutting down'));
    }
    // Kept entries are released here and nowhere else: shutdown is the one place
    // `keep_resident` stops applying, since leaving a model loaded after the
    // gateway exits would strand memory with nothing left to free it.
    for (const slot of [resident, ...kept.values()]) {
      if (!slot) continue;
      try {
        await releaseSlot(slot);
      } catch (error) {
        logger.error('failed to release the resident slot during shutdown', {
          event: 'slot.release_failed',
          runtime: slot.instance.id,
          error: (error as Error).message,
        });
      }
    }
    kept.clear();
    resident = null;
    serving = null;
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const waiter = waiters.shift();
        if (!waiter) break;
        if (waiter.settled) continue;
        if (waiter.signal?.aborted) {
          settle(waiter, () => waiter.reject(abortError()));
          continue;
        }
        try {
          const slot = await ensureResident(waiter);
          if (waiter.signal?.aborted) {
            // The client vanished while the runtime was coming up. The runtime
            // stays resident; the next waiter benefits from the warm start.
            settle(waiter, () => waiter.reject(abortError()));
            continue;
          }
          slot.leases += 1;
          settle(waiter, () => waiter.resolve(makeLease(slot)));
        } catch (error) {
          settle(waiter, () => waiter.reject(error));
        }
      }
    } finally {
      pumping = false;
      // A waiter may have arrived while the loop was finishing.
      if (waiters.length > 0) void pump();
    }
  };

  const settle = (waiter: Waiter, action: () => void): void => {
    waiter.settled = true;
    pending -= 1;
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    action();
  };

  const makeLease = (slot: Slot): Lease => {
    let released = false;
    return {
      runtime: slot.instance,
      adapter: slot.adapter,
      release: () => {
        if (released) return;
        released = true;
        slot.leases -= 1;
        if (slot.leases <= 0) {
          slot.leases = 0;
          const waiters = drainWaiters;
          drainWaiters = [];
          for (const resolve of waiters) resolve();
        }
        void pump();
      },
    };
  };

  /**
   * Bring the target entry to `ready` and give it the serving token, switching
   * if needed.
   *
   * The comparison is on entry ids, never on backend model names (§9): two
   * entries may serve the same backend model with different launch options, and
   * moving between them is a full release/acquire cycle.
   */
  const ensureResident = async (waiter: Waiter): Promise<Slot> => {
    const instance = waiter.instance;
    const existing = slotFor(instance.id);

    if (existing && existing.state === 'ready') {
      if (existing === serving) return existing;
      // Already in memory, just not answering. Hand the token over: no acquire,
      // no release, nothing loaded and nothing freed. This is the whole point of
      // `keep_resident` — reaching the kept model must not cost the other one.
      await drainServing();
      serving = existing;
      logger.info('serving token handed to a model already in memory', {
        event: 'slot.handover',
        runtime: instance.id,
        adapter: existing.adapter.id,
        requestId: waiter.requestId,
      });
      return existing;
    }

    switching = instance.id;
    const startedAt = Date.now();
    try {
      await drainServing();

      // Loaded but no longer ready. Rebuild it rather than proxy into whatever
      // is left of it; `discard` will not stop a server that is already gone.
      if (existing) await discard(existing);

      // Only a rotating entry is ever released by a switch, and only to make
      // room for a different rotating entry. A kept target takes the token
      // without disturbing the occupant at all.
      if (!instance.keepResident && resident && resident.instance.id !== instance.id) {
        await releaseRotating(resident);
        resident = null;
      } else if (instance.keepResident && resident) {
        logger.info('leaving the current occupant loaded for a kept entry', {
          event: 'slot.kept',
          runtime: resident.instance.id,
          adapter: resident.adapter.id,
          requestId: waiter.requestId,
        });
      }

      const adapter = registry.get(instance.adapterId);
      const slot: Slot = {
        instance,
        adapter,
        state: 'starting',
        ownership: 'unknown',
        leases: 0,
        since: Date.now(),
      };
      const keepLoaded = keepLoadedFor(instance);
      if (instance.keepResident) kept.set(instance.id, slot);
      else resident = slot;
      const log = logger.child({
        runtime: instance.id,
        adapter: adapter.id,
        model: instance.backendModel,
        requestId: waiter.requestId,
      });
      log.info('acquiring the resident slot', {
        event: 'slot.acquire',
        keepResident: instance.keepResident,
      });

      try {
        slot.state = 'loading';
        const result = await adapter.acquire(instance, {
          timeoutMs: readyTimeoutMs,
          ...(keepLoaded.length > 0 ? { keepLoaded } : {}),
        });
        slot.ownership = result.ownership;
        log.info('server ready', {
          event: 'runtime.started',
          ownership: result.ownership,
          durationMs: Date.now() - startedAt,
        });

        // Readiness is not "the process started" (§16).
        await adapter.waitUntilReady(instance, { timeoutMs: readyTimeoutMs });

        // Model identity verification (§17). Never silently proxy to the wrong model.
        const identity = await adapter.verifyIdentity(instance, {
          ...(keepLoaded.length > 0 ? { keepLoaded } : {}),
        });
        if (!identity.ok) {
          throw gatewayError(
            'RUNTIME_MODEL_MISMATCH',
            `${adapter.id} did not load "${instance.backendModel}" for entry "${instance.id}"`,
            {
              details: {
                runtime: instance.id,
                adapter: adapter.id,
                expected: adapter.servedModelId(instance),
                served: [...identity.served],
                detail: identity.detail,
              },
            },
          );
        }

        slot.state = 'ready';
        slot.since = Date.now();
        serving = slot;
        log.info('runtime ready', {
          event: 'runtime.ready',
          durationMs: Date.now() - startedAt,
          ownership: slot.ownership,
        });
        return slot;
      } catch (error) {
        slot.state = 'failed';
        log.error('failed to make the runtime resident', {
          event: 'runtime.acquire_failed',
          error: (error as Error).message,
          errorCode: isGatewayError(error) ? error.code : undefined,
        });
        // Leave nothing half-resident: free the slot before propagating.
        try {
          await adapter.release(instance);
        } catch (releaseError) {
          log.warn('cleanup release failed', {
            event: 'slot.release_failed',
            error: (releaseError as Error).message,
          });
        }
        if (kept.get(instance.id) === slot) kept.delete(instance.id);
        if (resident === slot) resident = null;
        if (serving === slot) serving = null;
        throw wrapAcquireError(error, instance);
      }
    } finally {
      switching = null;
    }
  };

  /**
   * Drain the slot holding the serving token, so only one entry ever answers at
   * a time. Nothing is released: the caller decides that separately.
   */
  const drainServing = async (): Promise<void> => {
    const slot = serving;
    if (!slot || slot.leases <= 0) return;
    const log = logger.child({
      runtime: slot.instance.id,
      adapter: slot.adapter.id,
      model: slot.instance.backendModel,
    });
    const wasFailed = slot.state === 'failed';
    slot.state = 'draining';
    log.info('draining active requests before switching', {
      event: 'slot.drain',
      activeRequests: slot.leases,
    });
    try {
      await waitForDrain(slot);
    } finally {
      // `draining` is a transition that is now over, whether it succeeded or
      // timed out. Left as it was, even a request for this very entry would fail
      // the `state === 'ready'` test, take the switch path and wait out the
      // whole timeout again — and so would every request after it (§24, §34).
      slot.state = wasFailed ? 'failed' : 'ready';
    }
  };

  /** Free the rotating occupant with its own adapter. Already drained. */
  const releaseRotating = async (slot: Slot): Promise<void> => {
    const wasFailed = slot.state === 'failed';
    slot.state = 'stopping';

    if (wasFailed) {
      // The occupant already failed. If nothing answers any more, the runtime is
      // gone and holds no memory, so a release error must not wedge the queue
      // behind a corpse. If it *is* still answering, a release failure is real:
      // something is resident that will not let go, and that outranks recovery.
      const health = await slot.adapter
        .health(slot.instance)
        .catch(() => ({ state: 'unreachable' as const }));
      if (health.state === 'unreachable') {
        try {
          await releaseSlot(slot);
        } catch (error) {
          logger.warn('ignoring release failure for a runtime that is already gone', {
            event: 'slot.release_after_crash',
            runtime: slot.instance.id,
            adapter: slot.adapter.id,
            error: (error as Error).message,
          });
          lastRelease = { modelId: slot.instance.id, via: slot.adapter.modelRelease };
        }
        if (serving === slot) serving = null;
        return;
      }
    }

    await releaseSlot(slot);
    if (serving === slot) serving = null;
  };

  /**
   * Forget a loaded entry that is no longer ready, so the next acquire rebuilds
   * it from scratch.
   *
   * Un-keeping is never permanent: the caller re-acquires immediately and the
   * entry re-enters `kept`, so a transient blip does not silently turn
   * `keep_resident` back into reload-every-time.
   *
   * The release is attempted and its failure tolerated, which is
   * `releaseRotating`'s existing rule for a failed occupant: a runtime that no
   * longer answers holds no memory, so a stop command that fails against it
   * must not wedge the entry. Attempting it anyway is what clears a runtime
   * that is merely wedged rather than gone.
   */
  const discard = async (slot: Slot): Promise<void> => {
    kept.delete(slot.instance.id);
    if (resident === slot) resident = null;
    if (serving === slot) serving = null;
    await releaseRotating(slot).catch((error: unknown) => {
      logger.warn('could not release a runtime before rebuilding it', {
        event: 'slot.release_failed',
        runtime: slot.instance.id,
        adapter: slot.adapter.id,
        error: (error as Error).message,
      });
    });
  };

  const releaseSlot = async (slot: Slot): Promise<void> => {
    const log = logger.child({
      runtime: slot.instance.id,
      adapter: slot.adapter.id,
      model: slot.instance.backendModel,
    });
    if (slot.adapter.modelRelease === 'stop_server' && slot.ownership === 'attached') {
      // §8: the one-resident invariant outranks leaving a foreign single-model
      // server alone, and that has to be said out loud.
      log.warn(
        `releasing foreign ${slot.adapter.id} server on :${slot.instance.port ?? '?'} to free the resident slot`,
        { event: 'slot.release_foreign' },
      );
    }
    const startedAt = Date.now();
    try {
      await slot.adapter.release(slot.instance);
    } catch (error) {
      slot.state = 'failed';
      throw wrapReleaseError(error, slot);
    }
    slot.state = 'stopped';
    lastRelease = { modelId: slot.instance.id, via: slot.adapter.modelRelease };
    log.info('resident slot freed', {
      event: 'slot.released',
      via: slot.adapter.modelRelease,
      durationMs: Date.now() - startedAt,
    });
  };

  const waitForDrain = async (slot: Slot): Promise<void> => {
    if (slot.leases <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    const drained = new Promise<void>((resolve) => drainWaiters.push(resolve));
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), drainTimeoutMs);
    });
    try {
      const outcome = await Promise.race([drained.then(() => 'drained' as const), timeout]);
      if (outcome === 'timeout') {
        // A hung stream must surface as a real error rather than starving the
        // queue silently.
        throw gatewayError(
          'RUNTIME_SLOT_BUSY',
          `"${slot.instance.id}" still had ${slot.leases} active request(s) after ${drainTimeoutMs}ms`,
          {
            details: { runtime: slot.instance.id, activeRequests: slot.leases },
            hint: 'a client is holding a stream open; cancel it or raise the drain timeout',
          },
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return { status, acquire, switchTo, reportUpstreamFailure, shutdown };
};

/**
 * A cancelled wait. `RUNTIME_SLOT_BUSY` is the closest gateway code, so the
 * message carries the distinction the code cannot.
 *
 * A switch already in flight is *not* abandoned when the client that triggered
 * it disappears: the runtime is left resident so the next request finds it warm,
 * and draining still refuses to cut off an active stream (§8).
 */
const abortError = (): GatewayError => {
  return gatewayError('RUNTIME_SLOT_BUSY', 'request was cancelled while waiting for the runtime', {
    details: { reason: 'client_cancelled' },
  });
};

const wrapAcquireError = (error: unknown, instance: RuntimeInstance): unknown => {
  if (isGatewayError(error)) return error;
  return gatewayError(
    'RUNTIME_START_FAILED',
    `failed to start "${instance.id}": ${(error as Error).message}`,
    { details: { runtime: instance.id, adapter: instance.adapterId }, cause: error },
  );
};

const wrapReleaseError = (error: unknown, slot: Slot): unknown => {
  if (isGatewayError(error)) return error;
  const code =
    slot.adapter.modelRelease === 'unload_model' ? 'RUNTIME_UNLOAD_FAILED' : 'RUNTIME_STOP_FAILED';
  return gatewayError(
    code,
    `failed to release "${slot.instance.id}": ${(error as Error).message}`,
    {
      details: { runtime: slot.instance.id, adapter: slot.adapter.id },
      cause: error,
    },
  );
};
