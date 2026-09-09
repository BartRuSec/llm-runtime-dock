#!/usr/bin/env node
// Bundles the whole workspace into the single `dist/index.js` that ships on npm.
//
// `tsc` cannot do this: it emits file-per-file and never inlines `node_modules`,
// so a tsc-only build would have to publish every `workspace:*` package plus
// commander, yaml, zod, @inquirer/prompts, smol-toml and jsonc-parser as real
// dependencies. esbuild collapses all of it, which is why the published package
// declares no `dependencies` at all.

import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (typeof version !== 'string' || version.length === 0) {
  // The define below is a textual substitution: an empty version would inline
  // `undefined` and `lrd --version` would print it.
  throw new Error('bundle: the root package.json has no version');
}

await build({
  entryPoints: [fileURLToPath(new URL('src/index.ts', root))],
  outfile: fileURLToPath(new URL('dist/index.js', root)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // 'external', not true: `files` in package.json lists `dist/index.js` rather
  // than `dist`, so the map stays build-local — esbuild embeds `sourcesContent`,
  // and publishing the whole TypeScript source to npm is not what a global CLI
  // install is for. `true` would leave a `sourceMappingURL` comment in the
  // shipped file pointing at a map that is not in the tarball.
  sourcemap: 'external',
  // esbuild defaults to ['main', 'module'] on platform 'node'. `jsonc-parser`
  // has no `exports` map and points `main` at a UMD build whose inner
  // `require('./impl/format')` calls survive bundling and then resolve against
  // `dist/`, so the bundle dies on load. Preferring `module` picks its ESM
  // build instead. Only reaches packages without an `exports` map — every other
  // bundled dependency has one, and `exports` wins over `mainFields` outright.
  mainFields: ['module', 'main'],
  // Deliberately unminified: a few hundred kilobytes buys readable stack traces
  // from a globally installed binary, where there is no source checkout nearby.
  minify: false,
  // Textual substitution across the whole bundle, so `__LRD_VERSION__` may only
  // ever appear in this package's `src/` — a reference from `packages/` would
  // work here and fail that package's standalone typecheck.
  define: { __LRD_VERSION__: JSON.stringify(version) },
  // Required, not defensive. `@inquirer/prompts` pulls in a mixed CJS graph
  // (mute-stream, signal-exit, wrap-ansi, yoctocolors-cjs) whose `require`
  // calls survive into an ESM bundle. No shebang here — `bin/lrd.mjs` owns it.
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: 'info',
});
