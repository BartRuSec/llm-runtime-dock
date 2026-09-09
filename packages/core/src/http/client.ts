import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { gatewayError } from '../errors.js';
import type { GatewayError } from '../errors.js';
import type { AuthConfig, HealthStatus } from '../types.js';

/** Small HTTP helpers shared by adapters. Health, discovery and inference only (§10). */

export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export const httpRequest = async (
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> => {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
};

export const httpJson = async <T>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<{ status: number; ok: boolean; body: T | undefined; text: string }> => {
  const response = await httpRequest(url, options);
  let body: T | undefined;
  if (response.text.length > 0) {
    try {
      body = JSON.parse(response.text) as T;
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, ok: response.ok, body, text: response.text };
};

/**
 * Interpret a health endpoint response (§16).
 *
 * A bound port is not readiness. A 503 answer is `loading`, not a failure:
 * runtimes deliberately serve liveness before readiness.
 */
export const probeHealth = async (
  url: string,
  options: HttpRequestOptions = {},
): Promise<HealthStatus> => {
  let response: HttpResponse;
  try {
    response = await httpRequest(url, options);
  } catch (error) {
    return { state: 'unreachable', detail: (error as Error).message };
  }
  const body = parseBody(response.text);
  if (response.status === 503) {
    return { state: 'loading', httpStatus: 503, detail: shortDetail(response.text), body };
  }
  if (response.ok) {
    // Some runtimes report a non-ready status inside a 200 body.
    const status = extractStatus(response.text);
    if (status && /load|start|init/i.test(status)) {
      return { state: 'loading', httpStatus: response.status, detail: status, body };
    }
    return { state: 'ready', httpStatus: response.status, body };
  }
  return { state: 'error', httpStatus: response.status, detail: shortDetail(response.text) };
};

const parseBody = (text: string): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const extractStatus = (text: string): string | undefined => {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'status' in parsed) {
      const status = (parsed as { status: unknown }).status;
      return typeof status === 'string' ? status : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const shortDetail = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
};

/**
 * Expand a leading `~` to the home directory.
 *
 * Both separators are accepted: a configuration file is portable, and someone
 * on Windows may well have copied `~/.some-runtime/api-key` from the README.
 */
export const expandHome = (path: string): string => {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return resolvePath(homedir(), path.slice(2));
  }
  return resolvePath(path);
};

/**
 * Resolve an entry's upstream credential (§12). Used only when the client sent
 * no `Authorization` header. The resolved value is never logged.
 */
export const resolveAuthValue = (auth: AuthConfig | undefined): string | undefined => {
  if (!auth) return undefined;
  if (auth.apiKeyEnv) {
    const value = process.env[auth.apiKeyEnv];
    if (value && value.length > 0) return value;
  }
  if (auth.apiKeyFile) {
    const path = expandHome(auth.apiKeyFile);
    try {
      const contents = readFileSync(path, 'utf8').trim();
      if (contents.length > 0) return contents;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/** Map an upstream failure onto the gateway error namespace (§25). */
export const upstreamError = (status: number, url: string, detail?: string): GatewayError => {
  if (status === 401 || status === 403) {
    return gatewayError('UPSTREAM_UNAUTHORIZED', `upstream rejected the request (${status})`, {
      details: { url, status, detail },
      hint: "supply a credential through the entry's auth block, or send an Authorization header",
    });
  }
  return gatewayError('UPSTREAM_UNAVAILABLE', `upstream returned ${status}`, {
    details: { url, status, detail },
  });
};

/** Join a base URL with a path, tolerating a trailing slash on either side. */
export const joinUrl = (base: string, path: string): string => {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
};

export interface WaitForHealthOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  /** Called on each poll, so adapters can log the transition to `loading`. */
  readonly onState?: (status: HealthStatus) => void;
}

/**
 * Poll a health endpoint until it reports ready (§16).
 *
 * `loading` — including a 503 answer from an already-bound port — is a state to
 * keep waiting in, not a failure. Only the timeout turns it into one.
 */
export const waitUntilHealthy = async (
  url: string,
  options: WaitForHealthOptions = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  // Assigned on every pass before any read: the loop either throws or breaks
  // after `probeHealth`, so an initializer here would be dead.
  let last: HealthStatus;
  for (;;) {
    if (options.signal?.aborted) {
      throw gatewayError('RUNTIME_READY_TIMEOUT', `readiness wait cancelled for ${url}`);
    }
    last = await probeHealth(url, { timeoutMs: options.requestTimeoutMs ?? 5_000 });
    options.onState?.(last);
    if (last.state === 'ready') return;
    if (Date.now() >= deadline) break;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw gatewayError(
    'RUNTIME_READY_TIMEOUT',
    `${url} did not become ready within ${timeoutMs}ms (last state: ${last.state}${
      last.detail ? `, ${last.detail}` : ''
    })`,
    { details: { url, timeoutMs, state: last.state, detail: last.detail } },
  );
};

/** Wait until nothing answers on `url`, e.g. after stopping a server. */
export const waitUntilUnreachable = async (
  url: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await probeHealth(url, { timeoutMs: 1_000 });
    if (status.state === 'unreachable') return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
};

export const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
