#!/usr/bin/env node
// Foreground `ollama serve`: configuration arrives through OLLAMA_HOST/env vars.
const [host, port = '11434'] = (process.env.OLLAMA_HOST ?? '127.0.0.1:11434').split(':');
process.env.FAKE_OLLAMA = '1';
process.env.FAKE_MULTI = '1';
process.env.FAKE_MODELS = process.env.FAKE_MODELS ?? 'llama3.2';
process.env.FAKE_HOST = host;
process.env.FAKE_PORT = port;
await import('./fake-runtime.mjs');
