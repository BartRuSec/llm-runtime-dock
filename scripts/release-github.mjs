#!/usr/bin/env node
// `pnpm run release:github [--dry-run] [--draft]`: tag the release commit and
// publish a GitHub release for the version in the root `package.json`.
//
// The tag lives on `main`, because that is the only branch a release reaches
// (`develop` carries the work, `main` the release merge and the version bump
// that goes with it). Run `pnpm run version:bump` on `develop`, merge, then
// run this from `main`.
//
// The order — annotated tag, push, then `gh release create --verify-tag` — is
// load-bearing. Without `--verify-tag`, gh creates a missing tag itself from
// the default branch's tip, so a release can end up pointing at a commit that
// was never the one released. With it, the tag has to exist on the remote
// first, which is what the push is for.
//
// Nothing here publishes to npm; `npm publish` stays a separate, deliberate act.
//
// `spawn` gets `shell: true` on Windows for the same reason dev.mjs does: `git`
// and `gh` resolve through .cmd shims there.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { argv, exit, platform, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const syncVersion = fileURLToPath(new URL('sync-version.mjs', import.meta.url));

const REMOTE = 'origin';
const RELEASE_BRANCH = 'main';
/** The one place the tag is spelled. */
const tagFor = (version) => `v${version}`;

// pnpm forwards the `--` separator into argv, so `--dry-run` means the same
// with or without it.
const args = argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const draft = args.includes('--draft');

const unknown = args.filter((arg) => !['--dry-run', '--draft'].includes(arg));
if (unknown.length > 0) {
  stderr.write(`release-github: unknown argument(s): ${unknown.join(' ')}\n`);
  stderr.write('usage: node scripts/release-github.mjs [--dry-run] [--draft]\n');
  exit(1);
}

/** Run a command, resolving with its exit code and trimmed stdout. */
const run = (command, commandArgs, { inherit = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      shell: platform === 'win32',
      stdio: ['inherit', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.stderr?.on('data', () => {});
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({ code: signal ? 1 : (code ?? 0), out: out.trim() }),
    );
  });

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = tagFor(version);

// Every check is read-only, so they all run in a dry run too, and all of them
// run before anything is reported: one pass listing every blocker beats
// discovering them one release attempt at a time.
const problems = [];
const complain = (message) => problems.push(message);

const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
if (branch !== RELEASE_BRANCH) {
  complain(`on branch ${branch}; a release is cut from ${RELEASE_BRANCH}`);
}

const dirty = (await run('git', ['status', '--porcelain'])).out;
if (dirty.length > 0) complain('the working tree has uncommitted changes');

const fetched = await run('git', ['fetch', '--tags', REMOTE, RELEASE_BRANCH]);
if (fetched.code !== 0) {
  complain(`\`git fetch ${REMOTE} ${RELEASE_BRANCH}\` failed`);
} else {
  const head = (await run('git', ['rev-parse', 'HEAD'])).out;
  const upstream = (await run('git', ['rev-parse', `${REMOTE}/${RELEASE_BRANCH}`])).out;
  if (head !== upstream) complain(`HEAD is not ${REMOTE}/${RELEASE_BRANCH}; push or pull first`);
}

// The ten generated versions are what `prepack` would pack, so drift here means
// the tag would name a version the tarball does not.
if ((await run(process.execPath, [syncVersion, '--check'])).code !== 0) {
  complain(`package versions disagree with ${version}; run \`pnpm run version:sync\``);
}

if ((await run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])).code === 0) {
  complain(`the tag ${tag} already exists locally`);
}
if ((await run('git', ['ls-remote', '--tags', REMOTE, tag])).out.length > 0) {
  complain(`the tag ${tag} already exists on ${REMOTE}`);
}

// `--active` narrows this to the account gh would actually use: a bare
// `gh auth status` exits non-zero when *any* configured account fails to log
// in, which turns a stale second entry in hosts.yml into a permanent blocker.
if ((await run('gh', ['auth', 'status', '--active'])).code !== 0) {
  complain('`gh auth status --active` failed; run `gh auth login`');
}

const steps = [
  ['git', ['tag', '-a', tag, '-m', tag]],
  ['git', ['push', REMOTE, tag]],
  [
    'gh',
    ['release', 'create', tag, '--verify-tag', '--generate-notes', ...(draft ? ['--draft'] : [])],
  ],
];

const render = ([command, commandArgs]) =>
  `  ${command} ${commandArgs.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;

if (problems.length > 0) {
  stderr.write(`release-github: cannot release ${tag}:\n`);
  for (const problem of problems) stderr.write(`  - ${problem}\n`);
  if (dryRun) {
    stderr.write('the release would otherwise run:\n');
    for (const step of steps) stderr.write(`${render(step)}\n`);
  }
  exit(1);
}

if (dryRun) {
  stdout.write(`release-github: ${tag} is ready; would run:\n`);
  for (const step of steps) stdout.write(`${render(step)}\n`);
  exit(0);
}

for (const [command, commandArgs] of steps) {
  stdout.write(`${render([command, commandArgs]).trim()}\n`);
  const { code } = await run(command, commandArgs, { inherit: true });
  if (code !== 0) {
    stderr.write(`release-github: \`${command}\` failed; ${tag} is only partly released\n`);
    exit(code);
  }
}

stdout.write(`release-github: released ${tag}\n`);
