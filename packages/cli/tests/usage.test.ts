import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '@llm-runtime-dock/core';
import { runCli } from '../src/index.js';

/** `lrd usage` (spec §27): a client of `GET /usage`, never of `/status`. */

const zero = { requests: 0, input: 0, output: 0, cached: 0, noUsage: 0, failed: 0 };

let dir: string;
let configPath: string;
let server: Server;
let port: number;
let snapshot: UsageSnapshot;
let paths: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lrd-usage-'));
  configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, 'server: { host: 127.0.0.1, port: 8787 }\nmodels: {}\n');
  paths = [];
  snapshot = { since: '2026-10-07T08:00:00.000Z', models: {} };
  server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(snapshot));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const run = async (...extra: string[]) => {
  const out: string[] = [];
  const endpoint = `http://127.0.0.1:${port}`;
  const code = await runCli({
    argv: ['usage', '--config', configPath, '--endpoint', endpoint, ...extra],
    adapters: [],
    agents: [],
    stdout: (line) => out.push(line),
    stderr: () => undefined,
  });
  return { code, out: out.join('\n') };
};

describe('lrd usage', () => {
  it('asks /usage, not /status', async () => {
    await run();
    expect(paths).toEqual(['/usage']);
  });

  it('says so when nothing has been answered yet', async () => {
    const { out } = await run();
    expect(out).toContain('since:');
    expect(out).toContain('no requests answered yet');
  });

  it('prints one row, and optional columns only when something fills them', async () => {
    snapshot = {
      since: snapshot.since,
      models: { alpha: { ...zero, requests: 12, input: 48210, output: 9320 } },
    };
    const { out } = await run();
    expect(out).toMatch(/model\s+requests\s+input\s+output\s*$/m);
    expect(out).not.toMatch(/cached|no usage|failed|total/);
  });

  it('adds cached, no usage, failed and a total across several models', async () => {
    snapshot = {
      since: snapshot.since,
      models: {
        alpha: { ...zero, requests: 2, input: 10, output: 4, cached: 6, failed: 1 },
        beta: { ...zero, requests: 3, input: 5, output: 7, noUsage: 2 },
      },
    };
    const { out } = await run();
    expect(out).toMatch(/cached/);
    expect(out).toMatch(/no usage/);
    expect(out).toMatch(/failed/);
    expect(out).toMatch(/^total\s+5\s+15\s+11\s+6\s+2\s+1\s*$/m);
  });

  it('prints the snapshot untouched with --json', async () => {
    snapshot = { since: snapshot.since, models: { alpha: { ...zero, requests: 1 } } };
    const { out } = await run('--json');
    expect(JSON.parse(out)).toEqual(snapshot);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001b/);
  });

  it('exits non-zero when no gateway answers', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { code } = await run();
    expect(code).not.toBe(0);
  });
});
