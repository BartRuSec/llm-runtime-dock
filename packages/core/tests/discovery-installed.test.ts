import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  probeAdapter,
  renderDiscoveredModels,
  saveDiscovery,
  validateBackendModelRef,
  validateDiscoveredId,
} from '../src/index.js';
import type { AdapterProbeOutcome, ConfigLocation } from '../src/index.js';
import { createStubAdapter } from './helpers/stubs.js';

/**
 * Discovering models that are installed but not loaded (spec §22).
 *
 * A single-model runtime is idle most of the time. If discovery only worked
 * against a server with something loaded, it could never produce a usable
 * configuration — which is the whole point of it.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-installed-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const location = (path: string): ConfigLocation => ({
  path,
  found: true,
  candidates: [path],
  source: 'flag',
});

const installed = (adapter: string, ids: string[]): AdapterProbeOutcome => ({
  adapter,
  runtimeId: adapter,
  result: {
    status: 'not_running',
    url: 'http://127.0.0.1:8000',
    available: ids.map((id) => ({ id, suggestedId: id.split('/').pop() })),
  },
  skipped: [],
});

describe('models installed but not loaded', () => {
  it('writes configuration for a runtime whose server is down', () => {
    const path = join(dir, 'config.yaml');
    const result = saveDiscovery({
      outcomes: [installed('stub', ['Vendor/Some-Model-27B'])],
      location: location(path),
    });

    // A server that is down still gets its runtime block: that endpoint is
    // exactly what the gateway needs in order to start it later (§22).
    expect(result.added).toEqual({ runtimes: ['stub'], models: ['Some-Model-27B'] });
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('Some-Model-27B:');
    expect(written).toContain('backend_model: Vendor/Some-Model-27B');
  });

  it('keys the entry by the suggested id and keeps the backend reference intact', () => {
    const preview = renderDiscoveredModels([installed('stub', ['Vendor/Some-Model-27B'])]);
    expect(preview?.ids).toEqual(['Some-Model-27B']);
    expect(preview?.yaml).toContain('backend_model: Vendor/Some-Model-27B');
  });

  it('merges what is served with what is installed, without duplicating', () => {
    const outcome: AdapterProbeOutcome = {
      adapter: 'stub',
      runtimeId: 'stub',
      result: {
        status: 'running',
        url: 'http://127.0.0.1:8000',
        models: [{ id: 'Vendor/Loaded' }],
        available: [{ id: 'Vendor/Loaded' }, { id: 'Vendor/Idle' }],
      },
      skipped: [],
    };
    expect(renderDiscoveredModels([outcome])?.ids).toEqual(['Vendor/Loaded', 'Vendor/Idle']);
  });

  it('applies the key rule to the suggested id and the argv rule to the reference', async () => {
    const probed = await probeAdapter(
      createStubAdapter({
        probeResult: {
          status: 'not_running',
          url: 'http://127.0.0.1:1',
          available: [
            // A repo id is a valid reference but not a valid key, so each id is
            // checked against the rule for the field it lands in.
            { id: 'Vendor/Good-Model', suggestedId: 'good-model' },
            { id: '--rm-rf/evil', suggestedId: 'evil' },
            { id: 'Vendor/Fine', suggestedId: '-bad-key' },
          ],
        },
      }),
    );
    if (probed.result.status !== 'not_running') throw new Error('expected not_running');
    expect(probed.result.available?.map((m) => m.id)).toEqual(['Vendor/Good-Model']);
    expect(probed.skipped.map((s) => s.id)).toEqual(['--rm-rf/evil', '-bad-key']);
  });
});

describe('backend model references', () => {
  it('accepts a repo id, which a config key may not be', () => {
    expect(validateBackendModelRef('Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality').ok).toBe(true);
    expect(validateDiscoveredId('Youssofal/Qwen3.8-27B-MTPLX-Optimized-Quality').ok).toBe(false);
  });

  it('still refuses anything unsafe to put in a launch command', () => {
    const tab = String.fromCharCode(9);
    const nul = String.fromCharCode(0);
    for (const ref of [
      '--model',
      '',
      'has space',
      `a${tab}b`,
      `a${nul}b`,
      'vendor/../etc/passwd',
    ]) {
      expect(validateBackendModelRef(ref).ok).toBe(false);
    }
  });
});
