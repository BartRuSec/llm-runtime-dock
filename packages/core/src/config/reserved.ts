import type { ReservedArg, RuntimeAdapter } from '../adapter.js';
import { cliError } from '../errors.js';

/**
 * Reserved-argument enforcement (spec §12).
 *
 * The adapter's curated option schema is the allowlist. A key that is neither
 * curated nor reserved is invalid; a key that maps onto a reserved flag is
 * reserved. One list, no parallel bookkeeping to drift.
 *
 * The check covers `extra_args` too, otherwise the escape hatch reintroduces
 * exactly the problem the reserved list exists to prevent.
 */

/** Flags an `options:` key would plausibly render as. */
const candidateFlags = (key: string): string[] => {
  const kebab = key.replace(/_/g, '-');
  return [`--${kebab}`, `--${key}`, `-${key}`];
};

const matchReserved = (adapter: RuntimeAdapter, flag: string): ReservedArg | undefined => {
  return adapter.reservedArgs.find((reserved) => reserved.flags.includes(flag));
};

const reservedForOptionKey = (adapter: RuntimeAdapter, key: string): ReservedArg | undefined => {
  const byKey = adapter.reservedArgs.find((reserved) => reserved.optionKeys?.includes(key));
  if (byKey) return byKey;
  for (const flag of candidateFlags(key)) {
    const hit = matchReserved(adapter, flag);
    if (hit) return hit;
  }
  return undefined;
};

/** Every flag the adapter's curated options already own. */
const curatedFlags = (adapter: RuntimeAdapter): Map<string, string> => {
  const map = new Map<string, string>();
  for (const [key, spec] of Object.entries(adapter.optionSpecs)) {
    // A key that renders no flag of its own owns none, so it can never collide.
    if (spec.rendersNoFlag) continue;
    // `-c, --context-length` style specs declare both spellings.
    for (const flag of spec.flag.split(',').map((part) => part.trim())) {
      if (flag.startsWith('-')) map.set(flag, key);
    }
  }
  return map;
};

/**
 * Which block is being checked. The split between the two is read off the
 * adapter's own `serverScopedOptionKeys`, so an adapter states once where each
 * of its options belongs and core enforces it in both directions (§12).
 */
export type OptionScope = 'runtime' | 'model';

/**
 * @param path YAML path prefix of the block being checked — `models.coding-fast`
 *             or `runtimes.mtplx`. Every message here quotes it, so an error
 *             about a runtime block never points at a `models:` key.
 */
export const checkOptionKeys = (
  adapter: RuntimeAdapter,
  path: string,
  options: Record<string, unknown> | undefined,
  scope: OptionScope,
): void => {
  if (!options) return;
  const serverScoped = new Set(adapter.serverScopedOptionKeys);
  for (const key of Object.keys(options)) {
    if (key in adapter.optionSpecs) {
      // The key is curated, so the only question left is which block it belongs
      // in. Answering it here means a misplaced option is named and redirected
      // rather than reaching the adapter's schema as a mystery.
      if (scope === 'model' && serverScoped.has(key)) {
        throw cliError(
          'RUNTIME_OPTIONS_INVALID',
          `${path}.options.${key} configures the ${adapter.id} server, not the model`,
          {
            details: { entry: path, adapter: adapter.id, option: key, scope },
            hint: `move it to the options: block of the runtime this model names`,
          },
        );
      }
      if (scope === 'runtime' && !serverScoped.has(key)) {
        throw cliError(
          'RUNTIME_OPTIONS_INVALID',
          `${path}.options.${key} configures a model, not the ${adapter.id} server`,
          {
            details: { entry: path, adapter: adapter.id, option: key, scope },
            hint:
              serverScoped.size === 0
                ? `the ${adapter.id} adapter has no server-scoped options; move every option to the model entry`
                : `server-scoped options for ${adapter.id} are: ${[...serverScoped].join(', ')}`,
          },
        );
      }
      continue;
    }
    const reserved = reservedForOptionKey(adapter, key);
    if (reserved) {
      throw cliError(
        'RUNTIME_OPTION_RESERVED',
        `${path}.options.${key} is reserved by the gateway: ${reserved.reason}`,
        {
          details: { entry: path, adapter: adapter.id, option: key, flags: [...reserved.flags] },
          hint: `use ${reserved.insteadUse} instead`,
        },
      );
    }
    throw cliError(
      'RUNTIME_OPTIONS_INVALID',
      `${path}.options.${key} is not a known ${adapter.id} option`,
      {
        details: { entry: path, adapter: adapter.id, option: key },
        hint: `known options: ${Object.keys(adapter.optionSpecs).join(', ') || '(none)'}; use extra_args for anything else`,
      },
    );
  }
};

/** Strip a `--flag=value` suffix so both spellings are checked identically. */
const flagOf = (arg: string): string => {
  const eq = arg.indexOf('=');
  return eq === -1 ? arg : arg.slice(0, eq);
};

/**
 * `extra_args` is the escape hatch for flags the adapter does not name, so a
 * curated flag passed through it is fine on its own — that is how the long tail
 * of options is reached. It is only an error when the corresponding named
 * option is *also* set, because then two values compete for one flag.
 */
export const checkExtraArgs = (
  adapter: RuntimeAdapter,
  path: string,
  extraArgs: readonly string[] | undefined,
  options?: Record<string, unknown>,
): void => {
  if (!extraArgs || extraArgs.length === 0) return;
  const curated = curatedFlags(adapter);
  for (const arg of extraArgs) {
    if (!arg.startsWith('-')) continue;
    const flag = flagOf(arg);
    const reserved = matchReserved(adapter, flag);
    if (reserved) {
      throw cliError(
        'RUNTIME_OPTION_RESERVED',
        `${path}.extra_args contains ${flag}, which is reserved by the gateway: ${reserved.reason}`,
        {
          details: { entry: path, adapter: adapter.id, flag, flags: [...reserved.flags] },
          hint: `use ${reserved.insteadUse} instead`,
        },
      );
    }
    const curatedKey = curated.get(flag);
    if (curatedKey !== undefined && options?.[curatedKey] !== undefined) {
      throw cliError(
        'RUNTIME_OPTIONS_INVALID',
        `${path}.extra_args contains ${flag}, which the "${curatedKey}" option already sets`,
        {
          details: { entry: path, adapter: adapter.id, flag, option: curatedKey },
          hint: `set options.${curatedKey} instead of passing ${flag} through extra_args`,
        },
      );
    }
  }
};
