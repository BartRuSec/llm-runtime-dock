#!/usr/bin/env node
// Stands in for the `omlx` CLI (spec §20). It manages the *server* only: there
// is deliberately no load/unload command, exactly as with the real thing.
//
//   omlx serve --host H --port P [--model-dir D ...]

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
  process.env.FAKE_MULTI = '1';
  process.env.FAKE_HOST = flag('--host') ?? '127.0.0.1';
  process.env.FAKE_PORT = flag('--port') ?? '0';
  // A spawned oMLX discovers models under its model directory. The fixture takes
  // that list from FAKE_MODELS, which it inherits from whatever started it.
  process.env.FAKE_MODELS = process.env.FAKE_MODELS ?? '';
  await import(fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url)));
} else {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}
