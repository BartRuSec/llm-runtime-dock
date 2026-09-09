import type { DockConfig } from './config/load.js';
import { gatewayError } from './errors.js';
import type { RuntimeInstance } from './types.js';

/**
 * Model resolution (spec §13). Clients send a logical id; the gateway API talks
 * to a resolved target, never directly to a config entry.
 */

const NAMESPACE = 'llm-runtime-dock';

/** Accepts `coding-fast` and the namespaced `llm-runtime-dock/coding-fast`. */
export const normalizeModelId = (clientModelId: string): string => {
  const trimmed = clientModelId.trim();
  const prefix = `${NAMESPACE}/`;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
};

/**
 * The ids a client may send: every configured entry that is not `disabled`
 * (§12).
 *
 * A disabled entry is configuration, not catalogue, so it is neither advertised
 * nor named back to a caller as something to try instead. Exported because
 * every report of "what does this gateway serve" has to answer it the same way.
 */
export const servedModelIds = (config: DockConfig): string[] =>
  [...config.models.values()]
    .filter((instance) => !instance.disabled)
    .map((instance) => instance.id);

export const resolveModel = (config: DockConfig, clientModelId: unknown): RuntimeInstance => {
  const known = servedModelIds(config);
  if (typeof clientModelId !== 'string' || clientModelId.trim() === '') {
    throw gatewayError('MODEL_NOT_FOUND', 'request is missing a "model" field', {
      hint: `configured model ids: ${known.join(', ') || '(none)'}`,
    });
  }
  const id = normalizeModelId(clientModelId);
  const instance = config.models.get(id);
  if (!instance) {
    throw gatewayError('MODEL_NOT_FOUND', `unknown model "${clientModelId}"`, {
      details: { model: clientModelId, known },
      hint: `configured model ids: ${known.join(', ') || '(none)'}`,
    });
  }
  // The one gate `disabled` is enforced at. Everything else omits the entry
  // from a list; this is what makes it unreachable, and it sits ahead of the
  // scheduler so a disabled entry can never take a lease (§12, §13).
  if (instance.disabled) {
    throw gatewayError('MODEL_NOT_FOUND', `model "${clientModelId}" is disabled in configuration`, {
      details: { model: clientModelId, disabled: true, known },
      hint: `remove "disabled: true" from models.${id} to serve it`,
    });
  }
  return instance;
};

/**
 * The `/v1/models` payload: configured logical ids, loaded or not (§15).
 *
 * Disabled entries are omitted — a client that cannot route to an id has no use
 * for seeing it advertised.
 */
export const listLogicalModels = (
  config: DockConfig,
): {
  object: 'list';
  data: Array<{ id: string; object: 'model'; owned_by: string; created: number }>;
} => {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: servedModelIds(config).map((id) => ({
      id,
      object: 'model' as const,
      owned_by: NAMESPACE,
      created,
    })),
  };
};
