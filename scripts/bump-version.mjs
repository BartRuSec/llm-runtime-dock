#!/usr/bin/env node
// `pnpm run version:bump <patch|minor|major|x.y.z>`: rewrite the one version.
//
// The root `package.json` is the only place a version is written, so this
// script touches that field and nothing else, then hands the private packages
// to `scripts/sync-version.mjs` — still the only thing that writes them. Chaining the two in the package.json script instead would not work:
// pnpm appends the forwarded arguments to the last command of the line, so
// `pnpm run version:bump patch` would reach sync-version and never the bump.
//
// `pnpm version` is deliberately not used: it commits and tags as a side
// effect, and the branch policy (`develop` for work, `main` for releases only)
// means a person decides where that commit lands. This prints the next
// commands rather than running them.
//
// The arithmetic is inline instead of pulling in `semver`, because
// `minimumReleaseAge` makes adding a dependency its own exercise.

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { argv, execPath, exit, platform, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const manifest = new URL('../package.json', import.meta.url);
const syncVersion = fileURLToPath(new URL('sync-version.mjs', import.meta.url));

// pnpm forwards the `--` separator into argv, so `pnpm run version:bump -- patch`
// and `pnpm run version:bump patch` have to mean the same thing.
const args = argv.slice(2).filter((arg) => arg !== '--');

const RELEASES = ['major', 'minor', 'patch'];
const EXPLICIT = /^\d+\.\d+\.\d+$/;

const usage = () => {
  stderr.write('usage: node scripts/bump-version.mjs <major|minor|patch|x.y.z>\n');
  exit(1);
};

if (args.length !== 1) usage();
const [target] = args;
if (!RELEASES.includes(target) && !EXPLICIT.test(target)) usage();

const json = JSON.parse(await readFile(manifest, 'utf8'));
const current = json.version;
if (typeof current !== 'string' || !EXPLICIT.test(current)) {
  stderr.write(`bump-version: the root package.json version is not x.y.z (${current})\n`);
  exit(1);
}

/** `patch` on 1.2.3 is 1.2.4; `minor` and `major` zero everything below them. */
const bump = (version, release) => {
  const [major, minor, patch] = version.split('.').map(Number);
  if (release === 'major') return `${major + 1}.0.0`;
  if (release === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const next = EXPLICIT.test(target) ? target : bump(current, target);

if (next === current) {
  stderr.write(`bump-version: already at ${current}\n`);
  exit(1);
}

// Written through the parsed object so key order survives, with prettier's
// two-space indent and trailing newline — the same idiom as sync-version.mjs.
await writeFile(manifest, `${JSON.stringify({ ...json, version: next }, null, 2)}\n`);
stdout.write(`bump-version: ${current} -> ${next}\n`);

// `shell: true` on Windows for the same reason dev.mjs does it.
const sync = spawn(execPath, [syncVersion], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  shell: platform === 'win32',
  stdio: 'inherit',
});
sync.once('exit', (code, signal) => {
  if (signal || code !== 0) exit(code ?? 1);
  stdout.write(`bump-version: commit the manifests, then \`pnpm run release:github\` from main\n`);
});
