/**
 * Endpoint model discovery.
 *
 * The behaviour worth pinning down is which probe wins and what "no answer"
 * means: an endpoint that cannot be reached is not the same as one with no
 * models, and conflating them would show an empty picker for a typo'd host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { describeModel, discoverModels } from './models.js';

/** A stub endpoint; `routes` maps a path to [status, body]. */
function stub(routes: Record<string, [number, unknown]>): Promise<{
  url: string; hits: string[]; auth: (string | undefined)[]; close: () => Promise<void>;
}> {
  const hits: string[] = [];
  const auth: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    auth.push(req.headers.authorization as string | undefined);
    const hit = routes[req.url ?? ''];
    if (!hit) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(hit[0], { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit[1]));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`, hits, auth,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const TAGS = {
  models: [
    { name: 'kimi-k3:cloud', remote_model: 'kimi-k3', remote_host: 'https://ollama.com', details: { parameter_size: '2.81T' } },
    { name: 'smollm:135m', details: { parameter_size: '134.52M' } },
    { name: 'ornith:9b', details: { parameter_size: '9.0B' } },
    { name: '', details: {} },
  ],
};

test('Ollama’s richer listing is preferred where it answers', async (t) => {
  const s = await stub({ '/api/tags': [200, TAGS] });
  t.after(() => s.close());
  const models = await discoverModels(s.url, { timeoutMs: 800 });
  assert.ok(models);
  // Alphabetical: a cloud model is not a lesser option to be listed last.
  assert.deepEqual(models.map((m) => m.id), ['kimi-k3:cloud', 'ornith:9b', 'smollm:135m']);
  assert.equal(models[0].remote, true);
  assert.equal(models[0].host, 'https://ollama.com');
  assert.equal(models[2].size, '134.52M');
  assert.deepEqual(s.hits, ['/api/tags'], '/v1/models must not be probed once tags answered');
});

test('anything OpenAI-compatible falls back to /v1/models', async (t) => {
  const s = await stub({ '/v1/models': [200, { data: [{ id: 'gpt-5' }, { id: 'glm-5.3-flash' }] }] });
  t.after(() => s.close());
  const models = await discoverModels(s.url, { timeoutMs: 800 });
  assert.deepEqual(models?.map((m) => m.id), ['glm-5.3-flash', 'gpt-5']);
  assert.equal(models?.[0].remote, false, 'the OpenAI shape cannot express this, so do not claim it');
  assert.deepEqual(s.hits, ['/api/tags', '/v1/models']);
});

test('unreachable is null, and is not the same as empty', async (t) => {
  // Nothing listening: a typo'd host must be distinguishable from a daemon
  // with nothing pulled, or the picker lies about which it is.
  assert.equal(await discoverModels('http://127.0.0.1:1', { timeoutMs: 300 }), null);

  const s = await stub({ '/api/tags': [200, { models: [] }] });
  t.after(() => s.close());
  assert.deepEqual(await discoverModels(s.url, { timeoutMs: 800 }), []);
});

test('a pasted /v1 suffix or trailing slash is tolerated', async (t) => {
  const s = await stub({ '/api/tags': [200, TAGS] });
  t.after(() => s.close());
  for (const suffix of ['', '/', '/v1']) {
    const models = await discoverModels(s.url + suffix, { timeoutMs: 800 });
    assert.equal(models?.length, 3, `failed for ${JSON.stringify(suffix)}`);
  }
});

test('a key is sent when the endpoint needs one to list', async (t) => {
  const s = await stub({ '/v1/models': [200, { data: [{ id: 'x' }] }] });
  t.after(() => s.close());
  await discoverModels(s.url, { apiKey: 'sk-test', timeoutMs: 800 });
  assert.ok(s.auth.every((a) => a === 'Bearer sk-test'));
});

test('the note names the trade rather than ranking the options', () => {
  assert.match(describeModel({ id: 'a', remote: true, host: 'https://ollama.com' }), /ollama\.com.*Fast/s);
  assert.match(describeModel({ id: 'b', remote: false, size: '9.0B' }), /Local · 9\.0B.*Free and private/s);
});
