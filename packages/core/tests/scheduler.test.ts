import { describe, expect, it } from 'vitest';
import {
  createAdapterRegistry,
  createLogger,
  createScheduler,
  gatewayError,
  parseConfig,
  proxyRequest,
} from '../src/index.js';
import type { RuntimeInstance } from '../src/index.js';
import { createStubAdapter, testLocation } from './helpers/stubs.js';
import type { StubAdapter, StubAdapterOptions } from './helpers/stubs.js';

/**
 * The resident slot (spec §8, §24), tested at core's own level.
 *
 * Cross-adapter switching against real runtimes is an end-to-end concern; what
 * belongs here is the invariant itself — one occupant, serialized transitions,
 * drain before release, release before acquire.
 */

const logger = createLogger({ level: 'error', write: () => {} });

const harness = (adapters: Record<string, StubAdapterOptions> = {}) => {
  const stubs: Record<string, StubAdapter> = {};
  for (const [id, options] of Object.entries({ stub: {}, ...adapters })) {
    stubs[id] = createStubAdapter({ ...options, id });
  }
  const registry = createAdapterRegistry(Object.values(stubs));
  const config = parseConfig(
    registry,
    `
runtimes:
${Object.keys(stubs)
  .flatMap((id) => [
    `  ${id}-1: { adapter: ${id}, port: 9001 }`,
    `  ${id}-2: { adapter: ${id}, port: 9002 }`,
  ])
  .join('\n')}
models:
${Object.keys(stubs)
  .flatMap((id) => [
    `  ${id}-a: { runtime: ${id}-1, backend_model: ${id}-model-a }`,
    `  ${id}-b: { runtime: ${id}-2, backend_model: ${id}-model-b }`,
  ])
  .join('\n')}
`,
    testLocation(),
  );
  const scheduler = createScheduler({ registry, logger, drainTimeoutMs: 2_000 });
  const model = (id: string): RuntimeInstance => config.models.get(id)!;
  return { scheduler, stubs, model };
};

describe('resident slot', () => {
  it('starts empty and reports the occupant once acquired', async () => {
    const { scheduler, model } = harness();
    expect(scheduler.status().resident).toBeNull();

    const lease = await scheduler.acquire(model('stub-a'));
    const status = scheduler.status();
    expect(status.resident?.modelId).toBe('stub-a');
    expect(status.resident?.state).toBe('ready');
    expect(status.resident?.activeRequests).toBe(1);
    lease.release();
    expect(scheduler.status().resident?.activeRequests).toBe(0);
  });

  it('does not release or reacquire for a second request on the ready occupant', async () => {
    const { scheduler, stubs, model } = harness();
    (await scheduler.acquire(model('stub-a'))).release();
    (await scheduler.acquire(model('stub-a'))).release();
    // One acquire, no release: a warm request must not restart anything.
    expect(stubs.stub!.calls).toEqual(['acquire:stub-a', 'ready:stub-a']);
  });

  it('releases the occupant before acquiring the next entry', async () => {
    const { scheduler, stubs, model } = harness();
    (await scheduler.acquire(model('stub-a'))).release();
    (await scheduler.acquire(model('stub-b'))).release();

    expect(stubs.stub!.calls).toEqual([
      'acquire:stub-a',
      'ready:stub-a',
      'release:stub-a',
      'acquire:stub-b',
      'ready:stub-b',
    ]);
    expect(scheduler.status().lastRelease).toEqual({
      modelId: 'stub-a',
      via: 'stop_server',
      reason: 'switch',
    });
  });

  it('switches across adapters, releasing with the occupant’s own mechanism', async () => {
    const { scheduler, stubs, model } = harness({ multi: { modelRelease: 'unload_model' } });

    (await scheduler.acquire(model('multi-a'))).release();
    (await scheduler.acquire(model('stub-a'))).release();

    // The release step uses the current occupant's adapter, the acquire step the
    // target's; neither knows about the other.
    expect(stubs.multi!.calls).toContain('release:multi-a');
    expect(stubs.stub!.calls).toContain('acquire:stub-a');
    expect(scheduler.status().lastRelease).toEqual({
      modelId: 'multi-a',
      via: 'unload_model',
      reason: 'switch',
    });
  });

  it('treats two entries on one adapter as separate slot occupants', async () => {
    // A shared server is not a shared slot: both cannot be resident at once.
    const { scheduler, stubs, model } = harness();
    (await scheduler.acquire(model('stub-a'))).release();
    (await scheduler.acquire(model('stub-b'))).release();
    expect(stubs.stub!.calls.filter((c) => c.startsWith('release:'))).toEqual(['release:stub-a']);
  });

  it('serializes two simultaneous requests for the same cold entry into one acquire', async () => {
    const { scheduler, stubs, model } = harness({ stub: { acquireDelayMs: 30 } });
    const [a, b] = await Promise.all([
      scheduler.acquire(model('stub-a')),
      scheduler.acquire(model('stub-a')),
    ]);
    a.release();
    b.release();
    expect(stubs.stub!.calls.filter((c) => c === 'acquire:stub-a')).toHaveLength(1);
  });

  it('queues a different entry until the active request drains', async () => {
    const { scheduler, model } = harness();
    const held = await scheduler.acquire(model('stub-a'));

    let switched = false;
    const queued = scheduler.acquire(model('stub-b')).then((lease) => {
      switched = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The occupant is still in place; nothing may be released under an active request.
    expect(switched).toBe(false);
    expect(scheduler.status().resident?.modelId).toBe('stub-a');
    expect(scheduler.status().queueDepth).toBe(1);

    held.release();
    (await queued).release();
    expect(scheduler.status().resident?.modelId).toBe('stub-b');
  });

  it('surfaces a hung request as RUNTIME_SLOT_BUSY rather than starving the queue', async () => {
    const { scheduler, model } = harness();
    // Never released: the drain must time out with a real error.
    await scheduler.acquire(model('stub-a'));

    await expect(scheduler.acquire(model('stub-b'))).rejects.toMatchObject({
      code: 'RUNTIME_SLOT_BUSY',
    });
  });

  it('restores the occupant after a drain timeout, so a warm request does not restart it', async () => {
    const { scheduler, stubs, model } = harness();
    const hung = await scheduler.acquire(model('stub-a'));

    await expect(scheduler.acquire(model('stub-b'))).rejects.toMatchObject({
      code: 'RUNTIME_SLOT_BUSY',
    });

    // The drain timed out, so nothing was released: the occupant is still up.
    // Leaving it in `draining` would make even a request for this very entry
    // take the switch path and wait out the timeout all over again.
    expect(scheduler.status().resident?.modelId).toBe('stub-a');
    expect(scheduler.status().resident?.state).toBe('ready');

    hung.release();
    stubs.stub!.calls.length = 0;

    // A warm request for the entry that never stopped must not restart it (§24).
    (await scheduler.acquire(model('stub-a'))).release();
    expect(stubs.stub!.calls).toEqual([]);
  });

  it('hands the lease back when the proxy prelude throws, leaving the slot switchable', async () => {
    const { scheduler, stubs, model } = harness({ oai: { surfaces: ['openai'] } });
    const lease = await scheduler.acquire(model('oai-a'));

    // An Anthropic request on a runtime that serves only OpenAI fails in the
    // prelude, before the upstream is ever called.
    await expect(
      proxyRequest(
        {
          path: 'messages',
          body: JSON.stringify({ model: 'oai-a', messages: [] }),
          headers: {},
          signal: new AbortController().signal,
          requestId: 'surface-1',
        },
        { lease, logger },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_SURFACE_UNSUPPORTED' });

    // The lease came back, so nothing holds the slot for a request that never
    // ran — and the next switch does not have to wait out the drain timeout.
    expect(scheduler.status().resident?.activeRequests).toBe(0);
    (await scheduler.acquire(model('stub-a'))).release();
    expect(scheduler.status().resident?.modelId).toBe('stub-a');
    expect(stubs.oai!.calls).toContain('release:oai-a');
  });

  it('fails the switch instead of doubling residency when the occupant cannot be released', async () => {
    const pinned = gatewayError('RUNTIME_MODEL_PINNED', 'model is pinned');
    const { scheduler, model } = harness({ stuck: { failRelease: pinned } });

    (await scheduler.acquire(model('stuck-a'))).release();
    await expect(scheduler.acquire(model('stub-a'))).rejects.toMatchObject({
      code: 'RUNTIME_MODEL_PINNED',
    });
    // The occupant stays put; nothing new became resident alongside it.
    expect(scheduler.status().resident?.modelId).toBe('stuck-a');
  });

  it('frees the slot when acquiring fails, rather than leaving it half-resident', async () => {
    const { scheduler, stubs, model } = harness({
      broken: { failAcquire: new Error('process died') },
    });
    await expect(scheduler.acquire(model('broken-a'))).rejects.toMatchObject({
      code: 'RUNTIME_START_FAILED',
    });
    expect(scheduler.status().resident).toBeNull();
    expect(stubs.broken!.calls).toContain('release:broken-a');
  });

  it('fails with RUNTIME_MODEL_MISMATCH when the runtime serves something else', async () => {
    const { scheduler, model } = harness({ wrong: { serves: ['a-different-model'] } });
    await expect(scheduler.acquire(model('wrong-a'))).rejects.toMatchObject({
      code: 'RUNTIME_MODEL_MISMATCH',
    });
    expect(scheduler.status().resident).toBeNull();
  });

  it('rejects a queued request whose client cancels before it is served', async () => {
    const { scheduler, model } = harness();
    const held = await scheduler.acquire(model('stub-a'));

    const first = scheduler.acquire(model('stub-b'));
    const controller = new AbortController();
    const second = scheduler.acquire(model('stub-b'), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));

    controller.abort();
    await expect(second).rejects.toMatchObject({
      code: 'RUNTIME_SLOT_BUSY',
      details: { reason: 'client_cancelled' },
    });

    held.release();
    (await first).release();
    expect(scheduler.status().queueDepth).toBe(0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { scheduler, stubs, model } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      scheduler.acquire(model('stub-a'), { signal: controller.signal }),
    ).rejects.toThrow();
    expect(stubs.stub!.calls).toEqual([]);
  });

  it('re-runs the full start path after an upstream failure invalidates readiness', async () => {
    const { scheduler, stubs, model } = harness();
    (await scheduler.acquire(model('stub-a'))).release();
    scheduler.reportUpstreamFailure('stub-a', 'connection refused');
    expect(scheduler.status().resident?.state).toBe('failed');

    (await scheduler.acquire(model('stub-a'))).release();
    // Not proxied into a dead process: released, then acquired again.
    expect(stubs.stub!.calls.filter((c) => c === 'acquire:stub-a')).toHaveLength(2);
  });

  it('switchTo goes through the same queue as a request', async () => {
    const { scheduler, stubs, model } = harness();
    await scheduler.switchTo(model('stub-a'));
    expect(scheduler.status().resident?.modelId).toBe('stub-a');
    expect(scheduler.status().resident?.activeRequests).toBe(0);

    // A second switch for the same entry joins rather than starting another.
    await Promise.all([scheduler.switchTo(model('stub-b')), scheduler.switchTo(model('stub-b'))]);
    expect(stubs.stub!.calls.filter((c) => c === 'acquire:stub-b')).toHaveLength(1);
  });

  it('releases the occupant on shutdown', async () => {
    const { scheduler, stubs, model } = harness();
    (await scheduler.acquire(model('stub-a'))).release();
    await scheduler.shutdown();
    expect(stubs.stub!.calls).toContain('release:stub-a');
    expect(scheduler.status().resident).toBeNull();
  });
});

/**
 * `keep_resident` (spec §8).
 *
 * The flag splits what would otherwise be one thing into two: the *loaded set*,
 * which may hold a kept entry alongside the rotating occupant, and the *serving
 * token*, of which there is always exactly one. These tests pin the split — that
 * a kept entry survives a switch, that reaching it does not cost the occupant,
 * and that handing the token back and forth touches no adapter at all.
 */

const keptHarness = (yaml: string, options: StubAdapterOptions = {}) => {
  const stub = createStubAdapter({ ...options, id: 'stub' });
  const registry = createAdapterRegistry([stub]);
  const config = parseConfig(registry, yaml, testLocation());
  const scheduler = createScheduler({ registry, logger, drainTimeoutMs: 2_000 });
  const model = (id: string): RuntimeInstance => config.models.get(id)!;
  return { scheduler, stub, model };
};

/** A kept entry and a rotating one, each on its own single-model server. */
const SEPARATE_SERVERS = `
runtimes:
  small: { adapter: stub, port: 9001 }
  big: { adapter: stub, port: 9002 }
models:
  kept: { runtime: small, backend_model: small-model, keep_resident: true }
  big-a: { runtime: big, backend_model: big-model-a }
  big-b: { runtime: big, backend_model: big-model-b }
`;

describe('keep_resident', () => {
  it('does not release a kept entry when another entry takes the token', async () => {
    const { scheduler, stub, model } = keptHarness(SEPARATE_SERVERS);
    (await scheduler.acquire(model('kept'))).release();
    (await scheduler.acquire(model('big-a'))).release();

    expect(stub.calls).toEqual(['acquire:kept', 'ready:kept', 'acquire:big-a', 'ready:big-a']);
    expect(stub.calls).not.toContain('release:kept');
  });

  it('does not release the rotating occupant when a kept entry takes the token', async () => {
    const { scheduler, stub, model } = keptHarness(SEPARATE_SERVERS);
    (await scheduler.acquire(model('big-a'))).release();
    (await scheduler.acquire(model('kept'))).release();

    // Without this the flag would be worse than useless: reaching the small
    // model would evict the large one and every return trip would reload it.
    expect(stub.calls).not.toContain('release:big-a');
    expect(scheduler.status().resident?.modelId).toBe('big-a');
  });

  it('hands the token back to a model already in memory without touching the adapter', async () => {
    const { scheduler, stub, model } = keptHarness(SEPARATE_SERVERS);
    (await scheduler.acquire(model('big-a'))).release();
    (await scheduler.acquire(model('kept'))).release();
    stub.calls.length = 0;

    (await scheduler.acquire(model('big-a'))).release();
    (await scheduler.acquire(model('kept'))).release();

    // Both are loaded, so both handovers are free: no acquire, no release, no
    // readiness probe.
    expect(stub.calls).toEqual([]);
    expect(scheduler.status().serving).toBe('kept');
  });

  it('still releases the rotating occupant for a different rotating entry', async () => {
    const { scheduler, stub, model } = keptHarness(SEPARATE_SERVERS);
    (await scheduler.acquire(model('kept'))).release();
    (await scheduler.acquire(model('big-a'))).release();
    stub.calls.length = 0;

    (await scheduler.acquire(model('big-b'))).release();

    // Rotating → rotating is unchanged: release first, then acquire.
    expect(stub.calls).toEqual(['release:big-a', 'acquire:big-b', 'ready:big-b']);
    expect(scheduler.status().kept.map((entry) => entry.modelId)).toEqual(['kept']);
  });

  it('reports the kept set and the serving entry separately from the occupant', async () => {
    const { scheduler, model } = keptHarness(SEPARATE_SERVERS);
    (await scheduler.acquire(model('kept'))).release();
    const lease = await scheduler.acquire(model('big-a'));

    const status = scheduler.status();
    expect(status.resident?.modelId).toBe('big-a');
    expect(status.kept.map((entry) => entry.modelId)).toEqual(['kept']);
    expect(status.kept[0]?.state).toBe('ready');
    expect(status.serving).toBe('big-a');
    lease.release();
  });

  it('releases kept entries on shutdown, where the flag stops applying', async () => {
    const { scheduler, stub, model } = keptHarness(SEPARATE_SERVERS);
    (await scheduler.acquire(model('kept'))).release();
    (await scheduler.acquire(model('big-a'))).release();
    stub.calls.length = 0;

    await scheduler.shutdown();

    expect(stub.calls.sort()).toEqual(['release:big-a', 'release:kept']);
    expect(scheduler.status().kept).toEqual([]);
    expect(scheduler.status().serving).toBeNull();
  });

  it('re-acquires a kept entry whose upstream failed', async () => {
    const { scheduler, stub, model } = keptHarness(SEPARATE_SERVERS);
    (await scheduler.acquire(model('kept'))).release();
    (await scheduler.acquire(model('big-a'))).release();

    // A kept entry is not the occupant, so the old `resident.id === modelId`
    // test would have ignored this and proxied into a corpse on its next turn.
    scheduler.reportUpstreamFailure('kept', 'connection refused');
    expect(scheduler.status().kept[0]?.state).toBe('failed');

    stub.calls.length = 0;
    (await scheduler.acquire(model('kept'))).release();
    expect(stub.calls).toEqual(['release:kept', 'acquire:kept', 'ready:kept']);
    expect(scheduler.status().kept[0]?.state).toBe('ready');
  });

  it('rebuilds a kept entry whose runtime is gone, without wedging on the release', async () => {
    // Nothing answers and the release fails: the runtime holds no memory, so
    // that failure must not strand the entry. It is dropped, rebuilt, and kept
    // again — un-keeping on a blip is never permanent.
    const { scheduler, stub, model } = keptHarness(SEPARATE_SERVERS, {
      healthState: 'unreachable',
      failRelease: new Error('nothing to stop'),
    });
    (await scheduler.acquire(model('kept'))).release();
    scheduler.reportUpstreamFailure('kept', 'connection refused');

    stub.calls.length = 0;
    (await scheduler.acquire(model('kept'))).release();

    expect(stub.calls).toEqual(['release:kept', 'acquire:kept', 'ready:kept']);
    expect(scheduler.status().kept[0]?.state).toBe('ready');
  });

  it('tells an adapter which models on its own runtime to leave loaded', async () => {
    const { scheduler, stub, model } = keptHarness(
      `
runtimes:
  shared: { adapter: stub, port: 9001 }
  other: { adapter: stub, port: 9002 }
models:
  kept: { runtime: shared, backend_model: kept-model, keep_resident: true }
  rotating: { runtime: shared, backend_model: rotating-model }
  elsewhere: { runtime: other, backend_model: elsewhere-model }
`,
      { modelRelease: 'unload_model' },
    );

    (await scheduler.acquire(model('kept'))).release();
    (await scheduler.acquire(model('rotating'))).release();
    (await scheduler.acquire(model('elsewhere'))).release();

    // The kept entry shares a server with `rotating`, so that acquire must be
    // told to spare it. `elsewhere` is a different server, whose ids mean
    // nothing there.
    expect(stub.keepLoaded).toEqual([[], ['kept-model'], []]);
  });
});

/**
 * Idle unload (spec §29).
 *
 * The scheduler is otherwise entirely request-driven, so this is the one thing
 * in it that happens because time passed. Windows here are tens of milliseconds
 * and the clock is real — the repository has no fake timers, and the timeout is
 * injectable precisely so it does not need any.
 */

const idleHarness = (
  yaml: string,
  options: StubAdapterOptions = {},
  idleUnloadMs = 60,
): {
  scheduler: ReturnType<typeof createScheduler>;
  stub: StubAdapter;
  model: (id: string) => RuntimeInstance;
} => {
  const stub = createStubAdapter({ ...options, id: 'stub' });
  const registry = createAdapterRegistry([stub]);
  const config = parseConfig(registry, yaml, testLocation());
  const scheduler = createScheduler({ registry, logger, drainTimeoutMs: 2_000, idleUnloadMs });
  return { scheduler, stub, model: (id: string): RuntimeInstance => config.models.get(id)! };
};

const TWO_ROTATING = `
runtimes:
  one: { adapter: stub, port: 9001 }
  two: { adapter: stub, port: 9002 }
models:
  rot-a: { runtime: one, backend_model: model-a }
  rot-b: { runtime: two, backend_model: model-b }
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll rather than guess how long a release took. */
const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
};

describe('idle unload', () => {
  it('releases the rotating occupant after a quiet spell', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING);
    (await scheduler.acquire(model('rot-a'))).release();
    expect(scheduler.status().resident?.modelId).toBe('rot-a');

    await waitFor(() => scheduler.status().resident === null);
    expect(stub.calls).toContain('release:rot-a');
    expect(scheduler.status().lastRelease).toEqual({
      modelId: 'rot-a',
      via: 'stop_server',
      reason: 'idle',
    });
    expect(scheduler.status().serving).toBeNull();
  });

  it('never touches a kept entry, because an idle window is not a shutdown', async () => {
    const { scheduler, stub, model } = idleHarness(`
runtimes:
  small: { adapter: stub, port: 9001 }
  big: { adapter: stub, port: 9002 }
models:
  kept: { runtime: small, backend_model: small-model, keep_resident: true }
  big-a: { runtime: big, backend_model: big-model }
`);
    (await scheduler.acquire(model('kept'))).release();
    (await scheduler.acquire(model('big-a'))).release();

    // The occupant goes; `keep_resident` still means "for as long as the
    // gateway runs".
    await waitFor(() => scheduler.status().resident === null);
    await sleep(200);
    expect(stub.calls).not.toContain('release:kept');
    expect(scheduler.status().kept.map((entry) => entry.modelId)).toEqual(['kept']);

    await scheduler.shutdown();
    expect(stub.calls).toContain('release:kept');
  });

  it('does not fire while a request is still holding the slot', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING);
    const lease = await scheduler.acquire(model('rot-a'));

    await sleep(250);
    expect(stub.calls).not.toContain('release:rot-a');
    expect(scheduler.status().resident?.modelId).toBe('rot-a');

    lease.release();
    await waitFor(() => scheduler.status().resident === null);
  });

  it('restarts the window on every request', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, {}, 150);
    (await scheduler.acquire(model('rot-a'))).release();
    await sleep(100);
    (await scheduler.acquire(model('rot-a'))).release();
    await sleep(100);

    // 200ms have passed but never 150 of them in a row.
    expect(stub.calls).not.toContain('release:rot-a');
    await waitFor(() => scheduler.status().resident === null);
  });

  it('arms even when the request that started the runtime was cancelled', async () => {
    // The regression test for where the timer is armed. A client that vanishes
    // mid-acquire is settled with a rejection and never increments the lease
    // count, so nothing is ever released — arming from `lease.release()` would
    // leave this runtime loaded for the life of the process.
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, { acquireDelayMs: 120 });
    const controller = new AbortController();
    const pending = scheduler.acquire(model('rot-a'), { signal: controller.signal });
    await sleep(20);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_SLOT_BUSY' });

    // The runtime is deliberately left resident so the next request finds it warm.
    expect(scheduler.status().resident?.modelId).toBe('rot-a');
    await waitFor(() => scheduler.status().resident === null);
    expect(stub.calls).toContain('release:rot-a');
  });

  it('leaves a foreign single-model server alone, and says so once', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, {
      modelRelease: 'stop_server',
      ownership: 'attached',
    });
    (await scheduler.acquire(model('rot-a'))).release();

    await sleep(250);
    // A switch would stop it — it has to, to free memory for the next model.
    // Idle has nothing it needs the memory for.
    expect(stub.calls).not.toContain('release:rot-a');
    expect(scheduler.status().resident?.modelId).toBe('rot-a');
  });

  it('unloads from a shared server even when the gateway did not start it', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, {
      modelRelease: 'unload_model',
      ownership: 'attached',
    });
    (await scheduler.acquire(model('rot-a'))).release();

    // The unload names one model; everyone else on that server is unaffected.
    await waitFor(() => scheduler.status().resident === null);
    expect(stub.calls).toContain('release:rot-a');
  });

  it('survives a release that fails, and tries again on the next window', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, {
      failRelease: new Error('will not let go'),
    });
    (await scheduler.acquire(model('rot-a'))).release();

    await waitFor(() => stub.calls.filter((call) => call === 'release:rot-a').length >= 2);
    // Still loaded and still tracked: a runtime that will not let go is a real
    // problem, but not one a timer callback may crash the gateway over.
    expect(scheduler.status().resident?.modelId).toBe('rot-a');
  });

  it('serializes a request that arrives while the sweep is releasing', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, { releaseDelayMs: 200 });
    (await scheduler.acquire(model('rot-a'))).release();
    await waitFor(() => stub.calls.includes('release:rot-a'));

    // Mid-release: the sweep holds the same lock the pump does, so this queues
    // behind it rather than racing it into a second acquire/release cycle.
    (await scheduler.acquire(model('rot-b'))).release();

    expect(stub.calls).toEqual([
      'acquire:rot-a',
      'ready:rot-a',
      'release:rot-a',
      'acquire:rot-b',
      'ready:rot-b',
    ]);
    expect(scheduler.status().resident?.modelId).toBe('rot-b');
  });

  it('does not release the same slot twice when shutdown lands mid-sweep', async () => {
    // Shutdown does not take the pump's lock — until the idle timer existed,
    // nothing in the scheduler ran without a request in flight, so there was
    // nothing to take it from. This is the one window where both sides are
    // freeing the same slot.
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, { releaseDelayMs: 200 });
    (await scheduler.acquire(model('rot-a'))).release();
    await waitFor(() => stub.calls.includes('release:rot-a'));

    await scheduler.shutdown();

    expect(stub.calls.filter((call) => call === 'release:rot-a')).toHaveLength(1);
    expect(scheduler.status().resident).toBeNull();
    expect(scheduler.status().kept).toEqual([]);
  });

  it('leaves no timer behind after a shutdown', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING);
    (await scheduler.acquire(model('rot-a'))).release();

    await scheduler.shutdown();
    stub.calls.length = 0;
    await sleep(250);

    // Nothing is loaded, so a timer that survived would find nothing to free —
    // but it would still be a timer firing against a scheduler that is done.
    expect(stub.calls).toEqual([]);
  });

  it('does nothing at all when the window is zero', async () => {
    const { scheduler, stub, model } = idleHarness(TWO_ROTATING, {}, 0);
    (await scheduler.acquire(model('rot-a'))).release();

    await sleep(250);
    expect(stub.calls).not.toContain('release:rot-a');
    expect(scheduler.status().resident?.modelId).toBe('rot-a');
  });
});
