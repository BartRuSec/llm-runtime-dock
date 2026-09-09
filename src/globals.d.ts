/**
 * Injected by `scripts/bundle.mjs` through esbuild's `define`, from the version
 * in `package.json`. `define` is a textual substitution over the entire bundle,
 * so this identifier may only be used in this package's `src/` — a reference
 * from any `packages/*` source would resolve here but break that package's own
 * `tsc` run, which never sees this declaration.
 */
declare const __LRD_VERSION__: string;
