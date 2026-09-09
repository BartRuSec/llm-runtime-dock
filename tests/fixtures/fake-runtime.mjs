#!/usr/bin/env node
// A fake OpenAI/Anthropic-compatible runtime (spec §31).
//
// One fixture serves every adapter. Behaviour is driven entirely by environment
// variables so the same script can be spawned by a fake CLI, attached to as a
// "foreign" server, or told to misbehave in a specific way.
//
//   FAKE_HOST / FAKE_PORT        bind address (default 127.0.0.1 / random)
//   FAKE_PORT_FILE               write the chosen port here once listening
//   FAKE_MODEL                   single-model mode: the model served
//   FAKE_SERVE_MODEL             what /v1/models reports instead (mismatch tests)
//   FAKE_HEALTH_FLAVOR           answer /health the way a named runtime does (mtplx)
//   FAKE_MULTI=1                 multi-model mode: load/unload + residency
//   FAKE_MODELS=a,b,c            models discoverable in multi mode
//   FAKE_LOADED=a,b              models already resident at startup
//   FAKE_PINNED=a                models that refuse to unload
//   FAKE_AUTOLOAD=x              on any load, also make `x` resident (LRU sim)
//   FAKE_STARTUP_DELAY_MS        delay before binding the port at all
//   FAKE_LOADING_MS              bind, then answer /health with 503 for this long
//   FAKE_LOAD_DELAY_MS           how long POST .../load blocks
//   FAKE_CRASH_AFTER_MS          exit(1) after this long
//   FAKE_STOP_DELAY_MS           ignore SIGTERM for this long
//   FAKE_REQUIRE_KEY             require a credential everywhere except /health
//   FAKE_SURFACES=openai         restrict served surfaces (default both)
//   FAKE_STREAM_CHUNKS=5         SSE chunks per streaming completion
//   FAKE_STREAM_DELAY_MS=10      delay between SSE chunks
//   FAKE_STREAM_PAD_BYTES=0      pad each SSE chunk, to force real backpressure
//   FAKE_LOG_FILE                append a line per lifecycle event

import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const num = (name, fallback) => (env[name] ? Number(env[name]) : fallback);
const list = (name) => (env[name] ? env[name].split(',').filter(Boolean) : []);

// Ollama answers with a tag-qualified name whatever spelling was asked for, so
// every path that makes a model resident goes through here — otherwise a chat
// request for `llama3.2` and a load of `llama3.2:latest` show up in /api/ps as
// two models. The separator is only ever in the last path segment: the colon in
// `localhost:5000/mymodel` is a registry port, not a tag.
const residentName = (model) => {
  if (env.FAKE_OLLAMA !== '1') return model;
  const last = model.slice(model.lastIndexOf('/') + 1);
  return last.includes(':') ? model : `${model}:latest`;
};

const HOST = env.FAKE_HOST ?? '127.0.0.1';
const PORT = num('FAKE_PORT', 0);
const MULTI = env.FAKE_MULTI === '1';
const SINGLE_MODEL = env.FAKE_MODEL ?? 'fake-model';
const SERVED_MODEL = env.FAKE_SERVE_MODEL ?? SINGLE_MODEL;
const AVAILABLE = MULTI ? list('FAKE_MODELS') : [SERVED_MODEL];
const PINNED = new Set(list('FAKE_PINNED'));
const AUTOLOAD = env.FAKE_AUTOLOAD ?? '';
const SURFACES = env.FAKE_SURFACES ? env.FAKE_SURFACES.split(',') : ['openai', 'anthropic'];
const STREAM_CHUNKS = num('FAKE_STREAM_CHUNKS', 4);
const STREAM_DELAY_MS = num('FAKE_STREAM_DELAY_MS', 5);
const STREAM_PAD_BYTES = num('FAKE_STREAM_PAD_BYTES', 0);
const LOAD_DELAY_MS = num('FAKE_LOAD_DELAY_MS', 5);

const loaded = new Set(list('FAKE_LOADED'));
const startedAt = Date.now();
const loadingMs = num('FAKE_LOADING_MS', 0);

function note(event, detail = '') {
  if (!env.FAKE_LOG_FILE) return;
  appendFileSync(env.FAKE_LOG_FILE, `${JSON.stringify({ event, detail, t: Date.now() })}\n`);
}

function isLoading() {
  return Date.now() - startedAt < loadingMs;
}

function authorized(req) {
  if (!env.FAKE_REQUIRE_KEY) return true;
  const header = req.headers.authorization ?? '';
  const apiKey = req.headers['x-api-key'] ?? '';
  return header.startsWith('Bearer ') || apiKey.length > 0;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function modelsPayload() {
  return {
    object: 'list',
    data: AVAILABLE.map((id) => ({
      id,
      object: 'model',
      owned_by: 'fake',
      context_length: 131072,
    })),
  };
}

// oMLX names this array `models`, not `data` — `data` belongs to `/v1/models`.
// The fixture stands in for the real server, so the key has to match it.
function statusPayload() {
  return {
    model_count: AVAILABLE.length,
    loaded_count: loaded.size,
    models: AVAILABLE.map((id) => ({
      id,
      loaded: loaded.has(id),
      pinned: PINNED.has(id),
    })),
  };
}

function streamCompletion(res, model, anthropic) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let index = 0;
  const tick = () => {
    if (res.writableEnded) return;
    if (index >= STREAM_CHUNKS) {
      if (anthropic) {
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      } else {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion.chunk',
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }
    const payload = anthropic
      ? {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `chunk${index} ` },
        }
      : {
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: `chunk${index} ` }, finish_reason: null }],
        };
    // Padding exists so a test can outrun a client that is not reading: without
    // enough bytes in flight the socket never fills and `write` never returns
    // false, so the gateway's backpressure path is simply not reached.
    if (STREAM_PAD_BYTES > 0) payload.pad = 'x'.repeat(STREAM_PAD_BYTES);
    const eventName = anthropic ? 'event: content_block_delta\n' : '';
    res.write(`${eventName}data: ${JSON.stringify(payload)}\n\n`);
    index += 1;
    setTimeout(tick, STREAM_DELAY_MS);
  };
  setTimeout(tick, STREAM_DELAY_MS);
}

/**
 * Extra `/health` fields that identify which runtime this is pretending to be.
 *
 * Two adapters may default to one port, so a probe asks the server whether it
 * is that runtime's own before claiming it (§22). Without this a fake could
 * only ever be "some server", and the discrimination path would be untestable.
 */
const healthFlavor = () => {
  if (env.FAKE_HEALTH_FLAVOR === 'mtplx') {
    return {
      model: SERVED_MODEL,
      generation_mode: 'mtp',
      runtime_mode: 'turbo MTP',
      startup: { backend: { backend_id: 'fake_backend' } },
    };
  }
  return {};
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // /health never requires a credential (§20/§22).
  if (path === '/health' || path === '/v1/health') {
    if (isLoading()) {
      send(res, 503, { status: 'loading', detail: 'preloading model' });
      return;
    }
    send(res, 200, { ...healthFlavor(), status: 'ok', models_loaded: [...loaded] });
    return;
  }

  // Admin hooks used by the fake CLIs. Not part of any runtime's real API.
  if (path === '/__shutdown') {
    note('shutdown');
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (path === '/__ps') {
    send(
      res,
      200,
      [...loaded].map((id) => ({ identifier: id, modelKey: id, type: 'llm' })),
    );
    return;
  }
  if (path === '/__load' || path === '/__unload') {
    const id = url.searchParams.get('id') ?? '';
    if (path === '/__load') {
      if (!AVAILABLE.includes(id)) AVAILABLE.push(id);
      loaded.add(id);
      note('load', id);
    } else {
      loaded.delete(id);
      note('unload', id);
    }
    send(res, 200, { ok: true, loaded: [...loaded] });
    return;
  }

  // Ollama's native API is additive so the existing fake routes remain stable.
  if (env.FAKE_OLLAMA === '1') {
    if (path === '/api/version') {
      send(res, 200, { version: '0.33.3' });
      return;
    }
    if (!authorized(req)) {
      send(res, 401, { error: 'api key required' });
      return;
    }
    if (path === '/api/tags' && req.method === 'GET') {
      // Real Ollama always answers with a tag, whether or not one was pulled by
      // name, so the catalogue goes through the same normalizer as residency.
      send(res, 200, { models: AVAILABLE.map((name) => ({ name: residentName(name) })) });
      return;
    }
    if (path === '/api/ps' && req.method === 'GET') {
      send(res, 200, { models: [...loaded].map((name) => ({ name })) });
      return;
    }
    if (path === '/api/generate' && req.method === 'POST') {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw);
        const model = body.model ?? '';
        const name = residentName(model);
        if (!AVAILABLE.includes(model) && !AVAILABLE.includes(name)) {
          send(res, 404, { error: `unknown model ${model}` });
          return;
        }
        if (body.keep_alive === 0) loaded.delete(name);
        else loaded.add(name);
        send(res, 200, { done: true, model: name });
      });
      return;
    }
  }

  if (!authorized(req)) {
    send(res, 401, { error: { message: 'api key required', type: 'authentication_error' } });
    return;
  }

  if (path === '/v1/models' && req.method === 'GET') {
    send(res, 200, modelsPayload());
    return;
  }

  if (path === '/v1/models/status' && req.method === 'GET') {
    send(res, 200, statusPayload());
    return;
  }

  const lifecycle = /^\/v1\/models\/(.+)\/(load|unload)$/.exec(path);
  if (lifecycle && req.method === 'POST') {
    const id = decodeURIComponent(lifecycle[1]);
    const action = lifecycle[2];
    if (!AVAILABLE.includes(id)) {
      send(res, 404, { error: { message: `unknown model ${id}`, type: 'not_found' } });
      return;
    }
    if (action === 'unload') {
      if (PINNED.has(id)) {
        send(res, 409, { error: { message: `model ${id} is pinned`, type: 'conflict' } });
        return;
      }
      if (!loaded.has(id)) {
        send(res, 400, {
          error: { message: `model ${id} is not loaded`, type: 'invalid_request' },
        });
        return;
      }
      loaded.delete(id);
      note('unload', id);
      send(res, 200, { id, loaded: false });
      return;
    }
    // load blocks until the model is resident (§20).
    setTimeout(() => {
      loaded.add(id);
      if (AUTOLOAD && AUTOLOAD !== id) {
        if (!AVAILABLE.includes(AUTOLOAD)) AVAILABLE.push(AUTOLOAD);
        loaded.add(AUTOLOAD);
      }
      note('load', id);
      send(res, 200, { id, loaded: true });
    }, LOAD_DELAY_MS);
    return;
  }

  const anthropicPath = path === '/v1/messages' || path === '/v1/messages/count_tokens';
  if (anthropicPath && !SURFACES.includes('anthropic')) {
    send(res, 404, { error: { message: 'not found', type: 'not_found' } });
    return;
  }
  if (path === '/v1/chat/completions' && !SURFACES.includes('openai')) {
    send(res, 404, { error: { message: 'not found', type: 'not_found' } });
    return;
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || anthropicPath)) {
    void readBody(req).then((raw) => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        send(res, 400, { error: { message: 'invalid json', type: 'invalid_request' } });
        return;
      }
      const model = body.model ?? '';
      const resident = residentName(model);
      if (
        MULTI &&
        !loaded.has(resident) &&
        (AVAILABLE.includes(model) || AVAILABLE.includes(resident))
      ) {
        // oMLX auto-loads on request; the gateway must drive residency itself.
        loaded.add(resident);
        note('autoload', resident);
      }
      const echo = {
        received_authorization: req.headers.authorization ?? null,
        received_x_api_key: req.headers['x-api-key'] ?? null,
        received_model: model,
        received_body: body,
      };
      if (path === '/v1/messages/count_tokens') {
        send(res, 200, { input_tokens: 42, ...echo });
        return;
      }
      if (body.stream === true) {
        streamCompletion(res, model, anthropicPath);
        return;
      }
      if (anthropicPath) {
        send(res, 200, {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'hello from the fake runtime' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 7 },
          ...echo,
        });
        return;
      }
      send(res, 200, {
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hello from the fake runtime' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        ...echo,
      });
    });
    return;
  }

  send(res, 404, { error: { message: `no route for ${path}`, type: 'not_found' } });
});

const stopDelayMs = num('FAKE_STOP_DELAY_MS', 0);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    note('signal', signal);
    setTimeout(() => process.exit(0), stopDelayMs);
  });
}

const crashAfterMs = num('FAKE_CRASH_AFTER_MS', 0);
if (crashAfterMs > 0) {
  setTimeout(() => {
    note('crash');
    process.exit(1);
  }, crashAfterMs).unref?.();
}

setTimeout(
  () => {
    server.listen(PORT, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : PORT;
      note('listening', String(port));
      if (env.FAKE_PORT_FILE) writeFileSync(env.FAKE_PORT_FILE, String(port));
      process.stdout.write(`fake-runtime listening on ${HOST}:${port}\n`);
    });
  },
  num('FAKE_STARTUP_DELAY_MS', 0),
);
