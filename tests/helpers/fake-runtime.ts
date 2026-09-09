import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { FAKE_RUNTIME } from './env.js';

/**
 * Starts the fake runtime fixture directly (no CLI in front of it), for tests
 * that need a server the gateway did not spawn — attach mode, probing, and the
 * "foreign server" release path.
 */

export interface FakeRuntimeOptions {
  readonly port: number;
  readonly host?: string;
  readonly model?: string;
  readonly serveModel?: string;
  readonly multi?: boolean;
  readonly ollama?: boolean;
  readonly models?: readonly string[];
  readonly loaded?: readonly string[];
  readonly pinned?: readonly string[];
  readonly autoload?: string;
  readonly requireKey?: boolean;
  readonly loadingMs?: number;
  readonly startupDelayMs?: number;
  readonly crashAfterMs?: number;
  readonly stopDelayMs?: number;
  readonly surfaces?: readonly string[];
  /** Answer `/health` the way this runtime does, so an adapter recognises it (§22). */
  readonly healthFlavor?: 'mtplx';
  readonly streamChunks?: number;
  readonly streamDelayMs?: number;
  /** Pad every SSE chunk, so a client that does not read causes real backpressure. */
  readonly streamPadBytes?: number;
  readonly logFile?: string;
}

export interface FakeRuntime {
  readonly port: number;
  readonly url: string;
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

export const fakeRuntimeEnv = (options: FakeRuntimeOptions): Record<string, string> => {
  const env: Record<string, string> = { FAKE_PORT: String(options.port) };
  if (options.host) env.FAKE_HOST = options.host;
  if (options.model) env.FAKE_MODEL = options.model;
  if (options.serveModel) env.FAKE_SERVE_MODEL = options.serveModel;
  if (options.multi) env.FAKE_MULTI = '1';
  if (options.ollama) env.FAKE_OLLAMA = '1';
  if (options.models) env.FAKE_MODELS = options.models.join(',');
  if (options.loaded) env.FAKE_LOADED = options.loaded.join(',');
  if (options.pinned) env.FAKE_PINNED = options.pinned.join(',');
  if (options.autoload) env.FAKE_AUTOLOAD = options.autoload;
  if (options.requireKey) env.FAKE_REQUIRE_KEY = '1';
  if (options.loadingMs) env.FAKE_LOADING_MS = String(options.loadingMs);
  if (options.startupDelayMs) env.FAKE_STARTUP_DELAY_MS = String(options.startupDelayMs);
  if (options.crashAfterMs) env.FAKE_CRASH_AFTER_MS = String(options.crashAfterMs);
  if (options.stopDelayMs) env.FAKE_STOP_DELAY_MS = String(options.stopDelayMs);
  if (options.surfaces) env.FAKE_SURFACES = options.surfaces.join(',');
  if (options.healthFlavor) env.FAKE_HEALTH_FLAVOR = options.healthFlavor;
  if (options.streamChunks) env.FAKE_STREAM_CHUNKS = String(options.streamChunks);
  if (options.streamDelayMs) env.FAKE_STREAM_DELAY_MS = String(options.streamDelayMs);
  if (options.streamPadBytes) env.FAKE_STREAM_PAD_BYTES = String(options.streamPadBytes);
  if (options.logFile) env.FAKE_LOG_FILE = options.logFile;
  return env;
};

export const startFakeRuntime = async (options: FakeRuntimeOptions): Promise<FakeRuntime> => {
  const child = spawn(process.execPath, [FAKE_RUNTIME], {
    env: { ...process.env, ...fakeRuntimeEnv(options) },
    stdio: 'ignore',
  });
  const url = `http://${options.host ?? '127.0.0.1'}:${options.port}`;

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.status === 200 || response.status === 503) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`fake runtime did not start on ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    port: options.port,
    url,
    child,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
};
