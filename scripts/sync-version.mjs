#!/usr/bin/env node
// The root `package.json` is the one and only place a version is written.
//
// Every workspace package is `private: true` and never reaches npm, but each
// still carries a `version` field: pnpm rewrites `workspace:*` to it when the
// root package is packed. Left to hand-editing, that field is eleven copies of
// one number, so this script generates the ten copies from the root's.
//
// `--check` writes nothing and exits non-zero on drift, which is what CI runs.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';

const root = new URL('../', import.meta.url);
const check = argv.includes('--check');

/** Workspace roots, mirroring `packages` in pnpm-workspace.yaml. */
const GROUPS = ['packages/', 'packages/agents/', 'packages/runtimes/', 'apps/'];

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));

/**
 * Every package manifest one level below a workspace root. Built with `readdir`
 * rather than a glob: no shell is involved, so this behaves the same on Windows.
 */
const manifests = async () => {
  const found = [];
  for (const group of GROUPS) {
    let entries;
    try {
      entries = await readdir(new URL(group, root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const label = `${group}${entry.name}/package.json`;
      const path = new URL(label, root);
      try {
        found.push({ label, path, json: await readJson(path) });
      } catch {
        // A grouping directory (packages/agents) has no manifest of its own.
      }
    }
  }
  return found;
};

const { version } = await readJson(new URL('package.json', root));
if (typeof version !== 'string' || version.length === 0) {
  stderr.write('sync-version: the root package.json has no version\n');
  exit(1);
}

const drift = [];
for (const manifest of await manifests()) {
  if (manifest.json.version === version) continue;
  drift.push(manifest);
  if (check) continue;
  // Rewritten through the parsed object so key order survives; prettier's
  // two-space indent and trailing newline are what `format:check` expects.
  const updated = { ...manifest.json, version };
  await writeFile(manifest.path, `${JSON.stringify(updated, null, 2)}\n`);
}

if (drift.length === 0) exit(0);

if (check) {
  stderr.write(
    `sync-version: ${drift.length} package(s) disagree with the root version ${version}:\n`,
  );
  for (const manifest of drift) stderr.write(`  ${manifest.label}: ${manifest.json.version}\n`);
  stderr.write('run `pnpm run version:sync` (or `pnpm build`) to update them\n');
  exit(1);
}
stdout.write(`sync-version: set ${drift.length} package(s) to ${version}\n`);
