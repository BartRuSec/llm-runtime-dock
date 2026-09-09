import type { RuntimeAdapter } from './adapter.js';
import { cliError, gatewayError } from './errors.js';

/**
 * Explicit plugin registration (spec §21). Core never imports a concrete
 * adapter; the composition root builds a registry and hands it in.
 */
export interface AdapterRegistry {
  register(adapter: RuntimeAdapter): AdapterRegistry;
  has(id: string): boolean;
  /** Look up an adapter for a request path. Throws a gateway-namespace error. */
  get(id: string): RuntimeAdapter;
  /**
   * Look up an adapter at config-load time. Throws a CLI-namespace error.
   *
   * `path` is the YAML path of the block that named it — `runtimes.mtplx` — so
   * the message points at the key the user has to fix.
   */
  require(id: string, path: string): RuntimeAdapter;
  list(): RuntimeAdapter[];
  ids(): string[];
}

export const createAdapterRegistry = (
  adapters: readonly RuntimeAdapter[] = [],
): AdapterRegistry => {
  const byId = new Map<string, RuntimeAdapter>();
  const ids = (): string[] => [...byId.keys()];

  const registry: AdapterRegistry = {
    register: (adapter) => {
      if (byId.has(adapter.id)) {
        throw cliError('CONFIG_INVALID', `duplicate runtime adapter id: ${adapter.id}`);
      }
      byId.set(adapter.id, adapter);
      return registry;
    },

    has: (id) => byId.has(id),

    get: (id) => {
      const adapter = byId.get(id);
      if (!adapter) {
        throw gatewayError('ADAPTER_NOT_FOUND', `no runtime adapter registered for "${id}"`, {
          details: { adapter: id, known: ids() },
          hint: `known adapters: ${ids().join(', ') || '(none)'}`,
        });
      }
      return adapter;
    },

    require: (id, path) => {
      const adapter = byId.get(id);
      if (!adapter) {
        throw cliError('CONFIG_INVALID', `${path}: unknown adapter "${id}"`, {
          details: { adapter: id, entry: path, known: ids() },
          hint: `known adapters: ${ids().join(', ') || '(none)'}`,
        });
      }
      return adapter;
    },

    list: () => [...byId.values()],
    ids,
  };

  for (const adapter of adapters) registry.register(adapter);
  return registry;
};
