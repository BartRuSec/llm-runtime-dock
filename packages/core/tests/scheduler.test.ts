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
    expect(scheduler.status().lastRelease).toEqual({ modelId: 'stub-a', via: 'stop_server' });
  });

  it('switches across adapters, releasing with the occupant’s own mechanism', async () => {
    const { scheduler, stubs, model } = harness({ multi: { modelRelease: 'unload_model' } });

    (await scheduler.acquire(model('multi-a'))).release();
    (await scheduler.acquire(model('stub-a'))).release();

    // The release step uses the current occupant's adapter, the acquire step the
    // target's; neither knows about the other.
    expect(stubs.multi!.calls).toContain('release:multi-a');
    expect(stubs.stub!.calls).toContain('acquire:stub-a');
    expect(scheduler.status().lastRelease).toEqual({ modelId: 'multi-a', via: 'unload_model' });
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
