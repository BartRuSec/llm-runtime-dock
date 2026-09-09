#!/usr/bin/env node
// ESM shim for the `lrd` binary. Keeps the Node version check ahead of any
// syntax the runtime might not understand, so an old Node fails readably.
const [major] = process.versions.node.split('.').map(Number);
if (!Number.isInteger(major) || major < 24) {
  process.stderr.write(
    `llm-runtime-dock requires Node.js >= 24 (found ${process.versions.node}).\n`,
  );
  process.exit(1);
}
const { main } = await import('../dist/index.js');
await main(process.argv);
