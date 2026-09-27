import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_API_KEY_ENV,
  generateServerKey,
  resolveServerAuthKey,
  toServerAuthConfig,
} from '../src/index.js';
import { testLocation } from './helpers/stubs.js';

/**
 * The gateway's own inbound key (spec §28) — distinct from `models.*.auth`,
 * covered in `config.test.ts`.
 */

describe('toServerAuthConfig', () => {
  it('an explicit server.auth wins even when LRD_API_KEY is also set', () => {
    const auth = toServerAuthConfig({ api_key_env: 'MY_KEY' }, { LRD_API_KEY: 'x' });
    expect(auth).toEqual({ apiKeyEnv: 'MY_KEY', apiKeyFile: undefined, source: 'config' });
  });

  it('falls back to LRD_API_KEY only when server.auth is entirely absent', () => {
    const auth = toServerAuthConfig(undefined, { LRD_API_KEY: 'x' });
    expect(auth).toEqual({ apiKeyEnv: DEFAULT_API_KEY_ENV, source: 'default_env' });
  });

  it('is undefined when neither is present', () => {
    expect(toServerAuthConfig(undefined, {})).toBeUndefined();
  });
});

describe('resolveServerAuthKey', () => {
  it('resolves an explicit api_key_env', () => {
    const auth = toServerAuthConfig({ api_key_env: 'MY_KEY' }, {});
    expect(resolveServerAuthKey(auth, { MY_KEY: 'secret' })).toBe('secret');
  });

  it('fails closed when an explicit api_key_env is unset', () => {
    const auth = toServerAuthConfig({ api_key_env: 'MY_KEY' }, {});
    expect(() => resolveServerAuthKey(auth, {})).toThrowError(
      expect.objectContaining({ code: 'SERVER_AUTH_UNRESOLVED' }),
    );
  });

  it('resolves an explicit api_key_file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lrd-server-auth-'));
    const path = join(dir, 'key');
    writeFileSync(path, 'file-secret\n');
    const auth = toServerAuthConfig({ api_key_file: path }, {});
    expect(resolveServerAuthKey(auth, {})).toBe('file-secret');
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails closed when an explicit api_key_file does not exist', () => {
    const auth = toServerAuthConfig({ api_key_file: '/nonexistent/lrd-key' }, {});
    expect(() => resolveServerAuthKey(auth, {})).toThrowError(
      expect.objectContaining({ code: 'SERVER_AUTH_UNRESOLVED' }),
    );
  });

  it('never throws for a default_env source — absence just means opting out', () => {
    const auth = toServerAuthConfig(undefined, { LRD_API_KEY: 'x' });
    // The variable is gone by the time this resolves; still not an error.
    expect(resolveServerAuthKey(auth, {})).toBeUndefined();
  });

  it('returns undefined when no auth is configured at all', () => {
    expect(resolveServerAuthKey(undefined, {})).toBeUndefined();
  });
});

describe('generateServerKey', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lrd-server-auth-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('file mode writes server.auth.api_key_file and a separate secret file', () => {
    const location = testLocation(join(dir, 'config.yaml'));
    const result = generateServerKey({ location, mode: 'file' });

    expect(result.written).toBe(true);
    expect(result.key).toMatch(/^lrd_/);
    expect(result.keyFilePath).toBeTruthy();
    expect(readFileSync(result.keyFilePath as string, 'utf8').trim()).toBe(result.key);

    const configText = readFileSync(result.path, 'utf8');
    expect(configText).toContain('api_key_file');
    // The plaintext key itself must never land in the YAML.
    expect(configText).not.toContain(result.key);
  });

  it('env mode never writes the secret to disk', () => {
    const location = testLocation(join(dir, 'config.yaml'));
    const result = generateServerKey({ location, mode: 'env', envName: 'MY_VAR' });

    expect(result.envName).toBe('MY_VAR');
    const configText = readFileSync(result.path, 'utf8');
    expect(configText).toContain('api_key_env: MY_VAR');
    expect(configText).not.toContain(result.key);
    expect(existsSync(join(dir, 'api_key'))).toBe(false);
  });

  it('defaults the env var name to LRD_API_KEY', () => {
    const location = testLocation(join(dir, 'config.yaml'));
    const result = generateServerKey({ location, mode: 'env' });
    expect(result.envName).toBe(DEFAULT_API_KEY_ENV);
  });

  it('refuses to replace an already-configured server.auth without --force', () => {
    const location = testLocation(join(dir, 'config.yaml'));
    generateServerKey({ location, mode: 'env' });
    expect(() => generateServerKey({ location, mode: 'file' })).toThrowError(
      expect.objectContaining({ code: 'SERVER_KEY_ALREADY_CONFIGURED' }),
    );
  });

  it('--force replaces it', () => {
    const location = testLocation(join(dir, 'config.yaml'));
    generateServerKey({ location, mode: 'env', envName: 'FIRST' });
    const second = generateServerKey({ location, mode: 'env', envName: 'SECOND', force: true });
    expect(readFileSync(second.path, 'utf8')).toContain('api_key_env: SECOND');
    expect(readFileSync(second.path, 'utf8')).not.toContain('FIRST');
  });

  it('mutates server: in place, leaving its other keys and comments untouched', () => {
    const path = join(dir, 'config.yaml');
    writeFileSync(
      path,
      '# a hand-written comment\nserver:\n  host: 0.0.0.0\n  port: 9999\nmodels: {}\n',
    );
    const result = generateServerKey({ location: testLocation(path), mode: 'env' });

    const text = readFileSync(result.path, 'utf8');
    expect(text).toContain('# a hand-written comment');
    expect(text).toContain('host: 0.0.0.0');
    expect(text).toContain('port: 9999');
    expect(text).toContain('api_key_env');
  });

  it('dry run reports the result and writes nothing', () => {
    const location = testLocation(join(dir, 'config.yaml'));
    const result = generateServerKey({ location, mode: 'file', dryRun: true });
    expect(result.written).toBe(false);
    expect(existsSync(result.path)).toBe(false);
    expect(result.content).toContain('api_key_file');
  });
});
