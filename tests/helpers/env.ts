import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import type { ConfigLocation } from '@llm-runtime-dock/core';

export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/**
 * Launch options for a fixture CLI.
 *
 * The fixtures are `.mjs` scripts with a shebang, which Windows cannot execute
 * directly, so they are always run through the current Node binary.
 */
export const fixtureCli = (script: string): { binary: string; binaryArgs: string[] } => {
  return { binary: process.execPath, binaryArgs: [script] };
};
export const FAKE_MTPLX = join(FIXTURES, 'fake-mtplx.mjs');
export const FAKE_OMLX = join(FIXTURES, 'fake-omlx.mjs');
export const FAKE_LMS = join(FIXTURES, 'fake-lms.mjs');
export const FAKE_OLLAMA = join(FIXTURES, 'fake-ollama.mjs');
export const FAKE_RUNTIME = join(FIXTURES, 'fake-runtime.mjs');

/** A temp directory removed at the end of the test. */
export const tempDir = (): { path: string; cleanup: () => void } => {
  const path = mkdtempSync(join(tmpdir(), 'lrd-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
};

/** An OS-assigned free port. Racy in principle, fine for a local test suite. */
export const freePort = async (): Promise<number> => {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
};

export const fakeLocation = (path = join(tmpdir(), 'lrd-test-config.yaml')): ConfigLocation => {
  return { path, found: true, candidates: [path], source: 'flag' };
};

export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 25 } = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/** Read a whole SSE/text stream into a string. */
export const readAll = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) return '';
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
};
