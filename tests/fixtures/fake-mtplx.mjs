#!/usr/bin/env node
// Stands in for the `mtplx` CLI (spec §18).
//
//   mtplx serve --model M --host H --port P [flags...]   foreground server
//   mtplx stop --port P                                  stop that server
//   mtplx status --json
//   mtplx models [--json]
//
// `models --json` reports the installed *catalogue* — what MTPLX could serve,
// independent of any port — from $FAKE_CATALOGUE (comma-separated repo ids,
// each optionally suffixed `!` to mark it as failing MTPLX's own validation).
//
// `serve` records its full argv to $FAKE_ARGV_FILE so tests can assert that
// launch options and extra_args reached the command line.

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.env.FAKE_ARGV_FILE) {
  appendFileSync(process.env.FAKE_ARGV_FILE, `${JSON.stringify(argv)}\n`);
}

if (command === 'serve') {
  const model = flag('--model') ?? 'fake-model';
  const host = flag('--host') ?? '127.0.0.1';
  const port = flag('--port') ?? '0';
  process.env.FAKE_MODEL = model;
  process.env.FAKE_HOST = host;
  process.env.FAKE_PORT = port;
  await import(fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url)));
} else if (command === 'stop') {
  const port = flag('--port');
  try {
    await fetch(`http://127.0.0.1:${port}/__shutdown`, { method: 'GET' });
  } catch {
    // Already gone: stopping something that is not running is not a failure.
  }
  process.stdout.write(`stopped :${port}\n`);
} else if (command === 'status') {
  process.stdout.write(JSON.stringify({ running: true }) + '\n');
} else if (command === 'models') {
  if (argv.includes('--json')) {
    // The shape the adapter parses. This list is deliberately the same whatever
    // port asked for it: MTPLX's catalogue belongs to the installation, not to a
    // server, which is what makes two runtimes of one adapter report identically.
    const catalogue = (process.env.FAKE_CATALOGUE ?? process.env.FAKE_MODEL ?? 'Vendor/fake-model')
      .split(',')
      .filter(Boolean)
      .map((entry) => ({
        repo_id: entry.endsWith('!') ? entry.slice(0, -1) : entry,
        validation: { ok: !entry.endsWith('!') },
      }));
    process.stdout.write(JSON.stringify({ models: catalogue }) + '\n');
  } else {
    process.stdout.write(`${process.env.FAKE_MODEL ?? 'fake-model'}\n`);
  }
} else {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}
