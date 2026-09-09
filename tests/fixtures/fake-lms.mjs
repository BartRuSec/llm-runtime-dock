#!/usr/bin/env node
// Stands in for the `lms` CLI (spec §19). Server lifecycle and model lifecycle
// are separate, and the server outlives the CLI process that started it.
//
//   lms server status --json
//   lms server start --port P
//   lms load <model> --identifier <id> [flags...] --yes
//   lms unload <id>
//   lms ps --json
//
// Shared state lives in $FAKE_LMS_STATE so successive CLI invocations agree.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_LMS_STATE ?? join(tmpdir(), 'fake-lms-state.json');

if (process.env.FAKE_ARGV_FILE) {
  appendFileSync(process.env.FAKE_ARGV_FILE, `${JSON.stringify(argv)}\n`);
}

function readState() {
  if (!existsSync(statePath)) return { running: false, port: null, pid: null };
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return { running: false, port: null, pid: null };
  }
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state));
}

function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function alive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.status < 500 || res.status === 503;
  } catch {
    return false;
  }
}

const [first, second] = argv;

if (first === 'server' && second === 'status') {
  const state = readState();
  const running = state.running && state.port ? await alive(state.port) : false;
  process.stdout.write(JSON.stringify({ running, port: running ? state.port : null }) + '\n');
} else if (first === 'server' && second === 'start') {
  const state = readState();
  if (state.running && state.port && (await alive(state.port))) {
    process.stdout.write(`server already running on :${state.port}\n`);
  } else {
    // The real `lms server start` returns once the daemon is up.
    const port = flag('--port') ?? '1234';
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          FAKE_MULTI: '1',
          FAKE_PORT: port,
          FAKE_MODELS: process.env.FAKE_MODELS ?? '',
        },
        detached: true,
        stdio: 'ignore',
      },
    );
    child.unref();
    writeState({ running: true, port: Number(port), pid: child.pid });
    for (let i = 0; i < 200; i += 1) {
      if (await alive(port)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    process.stdout.write(`server started on :${port}\n`);
  }
} else if (first === 'server' && second === 'stop') {
  // Present only so a test can prove the adapter never calls it.
  const state = readState();
  if (state.port) await fetch(`http://127.0.0.1:${state.port}/__shutdown`).catch(() => {});
  writeState({ running: false, port: null, pid: null });
  process.stdout.write('server stopped\n');
} else if (first === 'load') {
  const state = readState();
  const identifier = flag('--identifier');
  const model = argv[1];
  if (!state.running || !state.port) {
    process.stderr.write('no server running\n');
    process.exit(1);
  }
  await fetch(
    `http://127.0.0.1:${state.port}/__load?id=${encodeURIComponent(identifier ?? model)}`,
  );
  process.stdout.write(`loaded ${model} as ${identifier}\n`);
} else if (first === 'unload') {
  const state = readState();
  const identifier = argv[1];
  if (state.running && state.port) {
    await fetch(
      `http://127.0.0.1:${state.port}/__unload?id=${encodeURIComponent(identifier)}`,
    ).catch(() => {});
  }
  process.stdout.write(`unloaded ${identifier}\n`);
} else if (first === 'ps') {
  const state = readState();
  if (!state.running || !state.port) {
    process.stdout.write('[]\n');
  } else {
    const res = await fetch(`http://127.0.0.1:${state.port}/__ps`).catch(() => null);
    process.stdout.write((res ? await res.text() : '[]') + '\n');
  }
} else {
  process.stderr.write(`unknown command: ${argv.join(' ')}\n`);
  process.exit(2);
}
