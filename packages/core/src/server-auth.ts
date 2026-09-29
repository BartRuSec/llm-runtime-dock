import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { configWriteTarget, type ConfigLocation } from './config/paths.js';
import { newConfigDocument, requireMap } from './discovery.js';
import { cliError } from './errors.js';
import { backupFile, readTextIfExists, writeSecretFile, writeTextFile } from './fs-utils.js';
import { expandHome } from './http/client.js';
import type { Logger } from './logging.js';
import { nullLogger } from './logging.js';

/**
 * The gateway's own inbound API key (spec §28).
 *
 * Distinct from `models.*.auth`, which is a credential LRD sends *upstream*.
 * This one is required of LRD's own clients — the CLI, and every coding agent
 * `lrd apply` configures.
 */

/** Checked out of the box, with no configuration at all — matches `LRD_CONFIG`. */
export const DEFAULT_API_KEY_ENV = 'LRD_API_KEY';

export interface ServerAuthConfig {
  readonly apiKeyEnv?: string;
  readonly apiKeyFile?: string;
  /**
   * `'config'` when `server.auth` was written explicitly; `'default_env'` when
   * nothing was configured and `LRD_API_KEY` happened to be set. The two differ
   * in one way: an explicit source that fails to resolve is a misconfiguration
   * (§4) and `resolveServerAuthKey` throws; a default source that resolves to
   * nothing just means the operator never opted in.
   */
  readonly source: 'config' | 'default_env';
}

/**
 * `server.auth` wins outright when present. `LRD_API_KEY` is consulted only
 * when it is entirely absent — an operator who configured one source should
 * never be surprised by a second one.
 */
export const toServerAuthConfig = (
  raw: { readonly api_key_env?: string; readonly api_key_file?: string } | undefined,
  env: NodeJS.ProcessEnv,
): ServerAuthConfig | undefined => {
  if (raw) {
    return { apiKeyEnv: raw.api_key_env, apiKeyFile: raw.api_key_file, source: 'config' };
  }
  if (env[DEFAULT_API_KEY_ENV]) {
    return { apiKeyEnv: DEFAULT_API_KEY_ENV, source: 'default_env' };
  }
  return undefined;
};

/**
 * Resolve the gateway's own key to its actual value.
 *
 * Fail-closed for an explicit `source: 'config'`: an `api_key_env`/`api_key_file`
 * the operator named but that resolves to nothing is a misconfiguration that
 * would otherwise silently start the gateway with no authentication at all —
 * the one outcome this feature exists to prevent. `source: 'default_env'` never
 * throws, because its absence just means nobody opted in.
 */
export const resolveServerAuthKey = (
  auth: ServerAuthConfig | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined => {
  if (!auth) return undefined;
  if (auth.apiKeyEnv) {
    const value = env[auth.apiKeyEnv];
    if (value && value.length > 0) return value;
  }
  if (auth.apiKeyFile) {
    const path = expandHome(auth.apiKeyFile);
    try {
      const contents = readFileSync(path, 'utf8').trim();
      if (contents.length > 0) return contents;
    } catch {
      // Falls through to the failure below.
    }
  }
  if (auth.source === 'default_env') return undefined;
  throw cliError(
    'SERVER_AUTH_UNRESOLVED',
    `server.auth is configured but resolves to no value (${describeSource(auth)})`,
    {
      details: { apiKeyEnv: auth.apiKeyEnv, apiKeyFile: auth.apiKeyFile },
      hint: auth.apiKeyEnv
        ? `set the ${auth.apiKeyEnv} environment variable, or run \`lrd key generate\``
        : `check that ${auth.apiKeyFile} exists and is readable`,
    },
  );
};

const describeSource = (auth: ServerAuthConfig): string =>
  auth.apiKeyEnv ? `env ${auth.apiKeyEnv}` : (auth.apiKeyFile ?? '(unset)');

/**
 * Which source actually produced the resolved value — for display only
 * (`lrd serve`'s startup banner, `lrd doctor`). Mirrors `resolveServerAuthKey`'s
 * own env-then-file precedence exactly, so the two can never disagree: a
 * `server.auth` naming both an env var and a file, with the env var unset,
 * resolves from the file, and must not be labeled "env NAME" on that account.
 * Call only once `resolveServerAuthKey` has confirmed a value resolved.
 */
export const describeResolvedAuthSource = (
  auth: ServerAuthConfig,
  env: NodeJS.ProcessEnv,
): string => {
  if (auth.apiKeyEnv && env[auth.apiKeyEnv]) {
    return auth.source === 'default_env'
      ? `env ${auth.apiKeyEnv}, default`
      : `env ${auth.apiKeyEnv}`;
  }
  return 'file';
};

/**
 * Lenient variant for CLI *client* commands (`status`/`switch`): never throws,
 * so a misconfigured `server.auth` does not crash a command whose whole job is
 * to report on the gateway — the gateway's own 401 already says what is wrong.
 * Falls back to `LRD_API_KEY` directly when there is no local config to resolve
 * against at all (a bare `--endpoint` pointed at a remote gateway).
 */
export const tryResolveServerAuthKey = (
  config: { readonly server: { readonly auth: ServerAuthConfig | undefined } } | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined => {
  try {
    if (config) return resolveServerAuthKey(config.server.auth, env);
    return env[DEFAULT_API_KEY_ENV];
  } catch {
    return undefined;
  }
};

/** 256 bits, base64url-encoded, with a recognizable prefix. */
export const generateApiKey = (): string => `lrd_${randomBytes(32).toString('base64url')}`;

export interface GenerateServerKeyOptions {
  readonly location: ConfigLocation;
  readonly mode: 'file' | 'env';
  /** `mode: 'env'` only. Defaults to `LRD_API_KEY`. */
  readonly envName?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly logger?: Logger;
}

export interface GenerateServerKeyResult {
  readonly path: string;
  readonly content: string;
  readonly backup: string | null;
  /** Plaintext — surfaced exactly this once. */
  readonly key: string;
  readonly mode: 'file' | 'env';
  /** `mode: 'file'` only. */
  readonly keyFilePath?: string;
  /** `mode: 'env'` only. */
  readonly envName?: string;
  readonly written: boolean;
}

/**
 * Generate a key and wire `server.auth` to it, in place — the same
 * read/mutate/backup/write shape `saveDiscovery` uses, so an existing
 * configuration's comments and every other key survive untouched.
 */
export const generateServerKey = (options: GenerateServerKeyOptions): GenerateServerKeyResult => {
  const logger = options.logger ?? nullLogger;
  const path = configWriteTarget(options.location);
  const existingText = readTextIfExists(path);
  const doc = existingText === null ? newConfigDocument(undefined) : parseDocument(existingText);
  if (doc.errors.length > 0) {
    throw cliError('CONFIG_INVALID', `${path}: ${doc.errors[0]?.message ?? 'invalid YAML'}`, {
      details: { path },
    });
  }

  const server = requireMap(doc, path, 'server');
  if (isMap(server.get('auth')) && options.force !== true) {
    throw cliError('SERVER_KEY_ALREADY_CONFIGURED', `${path}: server.auth is already configured`, {
      details: { path },
      hint: 'pass --force to replace it',
    });
  }

  const key = generateApiKey();
  const envName = options.mode === 'env' ? (options.envName ?? DEFAULT_API_KEY_ENV) : undefined;
  const keyFilePath = options.mode === 'file' ? defaultKeyFilePath(path) : undefined;

  server.set(
    'auth',
    doc.createNode(keyFilePath ? { api_key_file: keyFilePath } : { api_key_env: envName }),
  );

  const content = doc.toString({ lineWidth: 0 });
  if (options.dryRun) {
    return {
      path,
      content,
      backup: null,
      key,
      mode: options.mode,
      ...(keyFilePath ? { keyFilePath } : {}),
      ...(envName ? { envName } : {}),
      written: false,
    };
  }

  if (keyFilePath) {
    // Never `backupFile`'d: a `.bak` of a secret is itself a leak.
    writeSecretFile(keyFilePath, `${key}\n`);
  }
  logger.info('writing configuration', { event: 'config.write', path });
  const backup = backupFile(path);
  writeTextFile(path, content);

  return {
    path,
    content,
    backup,
    key,
    mode: options.mode,
    ...(keyFilePath ? { keyFilePath } : {}),
    ...(envName ? { envName } : {}),
    written: true,
  };
};

const defaultKeyFilePath = (configPath: string): string => join(dirname(configPath), 'api_key');
