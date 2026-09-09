import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbeResult, ProbeTarget, RuntimeAdapter } from '@llm-runtime-dock/core';
import type { ProbePrompt, ProbeSavePrompt } from '../src/prompt.js';
import { probePromptMessage } from '../src/prompt.js';
import { runCli } from '../src/index.js';

/**
 * `lrd probe --interactive` and `--start` (spec §22, §27).
 *
 * What the adapter declares, what the CLI renders, and what a run that cannot
 * ask does about it.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-probe-i-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface StubOptions {
  readonly startsAt?: string;
  /** Probes recorded as `host:port`, so a test can prove the answer won. */
  readonly seen: string[];
}

const stubAdapter = (options: StubOptions): RuntimeAdapter =>
  ({
    id: 'stub',
    defaultProbeTarget: 'http://127.0.0.1:8000',
    probeQuestions: [
      { key: 'host', label: 'host', type: 'string', default: '127.0.0.1' },
      { key: 'port', label: 'port', type: 'number', default: 8000 },
    ],
    probe: async (target: ProbeTarget): Promise<ProbeResult> => {
      options.seen.push(target.url);
      // Down until something starts it, so `--start` has work to do.
      if (options.startsAt !== undefined && target.url !== options.startsAt) {
        return { status: 'not_running', url: target.url };
      }
      return { status: 'running', url: target.url, models: [{ id: 'found' }] };
    },
    ...(options.startsAt !== undefined
      ? { startServer: async () => ({ url: options.startsAt as string }) }
      : {}),
  }) as unknown as RuntimeAdapter;

const harness = (
  adapter: RuntimeAdapter,
  prompts: { probePrompt?: ProbePrompt; probeSavePrompt?: ProbeSavePrompt } = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (argv: string[]) =>
      runCli({
        argv,
        adapters: [adapter],
        agents: [],
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        ...prompts,
      }),
  };
};

describe('probe --interactive', () => {
  it('probes what the answer said, not what the flag suggested', async () => {
    const seen: string[] = [];
    // The flag pre-fills the question; the answer still wins over it.
    const h = harness(stubAdapter({ seen }), {
      probePrompt: async (request) => {
        expect(request.prefill.port).toBe(8001);
        expect(request.questions.map((q) => q.key)).toEqual(['host', 'port']);
        return { port: 9000 };
      },
    });

    expect(await h.run(['probe', 'stub', '--interactive', '--port', '8001'])).toBe(0);
    expect(seen).toEqual(['http://127.0.0.1:9000']);
  });

  it('skips a subject the answer declined, and probes nothing at all', async () => {
    const seen: string[] = [];
    const h = harness(stubAdapter({ seen }), { probePrompt: async () => null });

    expect(await h.run(['probe', 'stub', '--interactive'])).toBe(0);
    expect(seen).toEqual([]);
    expect(h.err.join('\n')).toContain('nothing selected');
  });

  it('offers to save what it found, and writes only when the answer says so', async () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'server: { host: 127.0.0.1, port: 8787 }\n');
    const h = harness(stubAdapter({ seen: [] }), {
      probePrompt: async () => ({}),
      probeSavePrompt: async (request) => {
        // The preview is what the answer is about, so it has to carry both blocks.
        expect(request.preview).toContain('runtimes:');
        expect(request.preview).toContain('found');
        return true;
      },
    });

    expect(await h.run(['probe', 'stub', '--interactive', '--config', path])).toBe(0);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('runtime: stub');
    expect(written).toContain('backend_model: found');
  });

  it('fails rather than quietly probing the defaults when it cannot ask', async () => {
    // Unlike stale-entry removal, there is no useful fallback: probing the
    // defaults is exactly what --interactive was asked not to do.
    const h = harness(stubAdapter({ seen: [] }));
    expect(await h.run(['probe', 'stub', '--interactive', '--json'])).toBe(1);
    expect(h.err.join('\n')).toContain('needs a terminal');
  });
});

describe('probe --start', () => {
  it('starts a backend it found down and re-probes where it came up', async () => {
    const seen: string[] = [];
    // Deliberately not the port that was asked for: the URL `startServer`
    // reports is the one the re-probe has to use.
    const h = harness(stubAdapter({ seen, startsAt: 'http://127.0.0.1:9999' }));

    expect(await h.run(['probe', 'stub', '--start'])).toBe(0);
    expect(seen).toEqual(['http://127.0.0.1:8000', 'http://127.0.0.1:9999']);
    expect(h.out.join('\n')).toContain('running, serving 1 model');
  });

  it('refuses actionably on an adapter that cannot be started from a probe', async () => {
    const seen: string[] = [];
    const adapter = stubAdapter({ seen });
    // Down, and no `startServer` to call.
    (adapter as { probe: unknown }).probe = async (target: ProbeTarget): Promise<ProbeResult> => {
      seen.push(target.url);
      return { status: 'not_running', url: target.url };
    };

    const h = harness(adapter);
    expect(await h.run(['probe', 'stub', '--start'])).toBe(1);
    expect(h.err.join('\n')).toContain('cannot be started from a probe');
  });
});

describe('the "probe this one?" question', () => {
  const request = (over: Partial<Parameters<typeof probePromptMessage>[0]> = {}) => ({
    adapterId: 'mtplx',
    runtimeId: 'mtplx',
    defaultUrl: 'http://127.0.0.1:8000',
    questions: [{ key: 'port' as const, label: 'port', type: 'number' as const, default: 8000 }],
    prefill: {},
    ...over,
  });

  it('asks about the runtime, not about an endpoint', () => {
    // Naming the address here reads as "probe it there, yes or no?", so somebody
    // who wanted a different port answers no and never reaches the port question.
    expect(probePromptMessage(request())).toBe('probe mtplx?');
  });

  it('names the adapter only when it is not already the runtime name', () => {
    expect(probePromptMessage(request({ runtimeId: 'my-box' }))).toBe('probe my-box (mtplx)?');
  });

  it('falls back to naming the endpoint when the adapter asks nothing', () => {
    // The one case where it has nowhere else to appear.
    expect(probePromptMessage(request({ questions: [] }))).toBe(
      'probe mtplx at http://127.0.0.1:8000?',
    );
  });
});
