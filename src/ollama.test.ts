/**
 * Ollama discovery tests.
 *
 * Discovery runs during preflight on every start, including the common case of
 * a machine with no Ollama at all — so "absent" and "slow" have to be ordinary
 * outcomes rather than errors, and that is most of what these check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverOllama, ollamaHost, ollamaProvider } from './ollama.js';

/** Stands in for `ollama serve`, including its ability to be unhelpful. */
function stubOllama(handler: (res: http.ServerResponse) => void): Promise<{ host: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => handler(res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        host: `127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function withHost<T>(host: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OLLAMA_HOST;
  if (host === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = host;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = saved;
  }
}

test('OLLAMA_HOST is honoured, however it is written', async () => {
  await withHost(undefined, async () => assert.equal(ollamaHost(), 'http://127.0.0.1:11434'));
  // The bare host:port form is the one Ollama's own docs use.
  await withHost('127.0.0.1:9999', async () => assert.equal(ollamaHost(), 'http://127.0.0.1:9999'));
  await withHost('http://box.local:1234/', async () => assert.equal(ollamaHost(), 'http://box.local:1234'));
  await withHost('https://ollama.example', async () => assert.equal(ollamaHost(), 'https://ollama.example'));
});

test('no Ollama running is null, not a throw', async () => {
  // Nothing is listening on this port; preflight must survive it quietly.
  await withHost('127.0.0.1:1', async () => {
    assert.equal(await discoverOllama(300), null);
  });
});

test('a server that answers with junk is also null', async (t) => {
  const stub = await stubOllama((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not json at all');
  });
  t.after(() => stub.close());
  await withHost(stub.host, async () => assert.equal(await discoverOllama(500), null));
});

test('models are listed, with cloud models marked and sorted last', async (t) => {
  const stub = await stubOllama((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      models: [
        { name: 'kimi-k3:cloud', remote_model: 'kimi-k3', details: { parameter_size: '2.81T' } },
        { name: 'smollm:135m', details: { parameter_size: '134.52M' } },
        { name: 'ornith:9b', details: { parameter_size: '9.0B' } },
        { name: '', details: {} },
      ],
    }));
  });
  t.after(() => stub.close());

  await withHost(stub.host, async () => {
    const models = await discoverOllama(500);
    assert.ok(models);
    assert.deepEqual(models.map((m) => m.id), ['ornith:9b', 'smollm:135m', 'kimi-k3:cloud']);
    assert.equal(models[0].remote, false);
    assert.equal(models[2].remote, true, 'a :cloud model is not local, and it matters');
    assert.equal(models[1].size, '134.52M');
  });
});

test('the discovered provider needs no credential and no configuration', async () => {
  await withHost('127.0.0.1:11434', async () => {
    const p = ollamaProvider('qwen3:8b');
    assert.equal(p.kind, 'openai-compatible');
    assert.ok(!('apiKeyEnv' in p) || p.apiKeyEnv === undefined,
      'a local endpoint has no key; the gateway placeholder is provider.ts’s job');
    assert.equal(p.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(p.model, 'qwen3:8b');
  });
});
