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
import { costRank, describeModel, discoverModels } from './models.js';

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

// ---------------------------------------------------------------------------
// What a picker is told about price
// ---------------------------------------------------------------------------

test('a published rate leads the description, in per-million terms', () => {
  // Per-token is how the source publishes and how prices.ts stores it; per
  // million is how a person reads a pricing page. The conversion happens here
  // and nowhere else.
  assert.equal(
    describeModel({ id: 'x', remote: false, price: { input: 0.000002, output: 0.00001 } }),
    '$2.00 in / $10.00 out per million tokens.',
  );
});

test('a sub-cent rate is not rounded away to nothing', () => {
  // "$0.00 in / $0.00 out" would say free about a model that is not.
  assert.equal(
    describeModel({ id: 'x', remote: false, price: { input: 0.00000005, output: 0.0000004 } }),
    '$0.050 in / $0.400 out per million tokens.',
  );
});

test('a model published at zero is described as free at that endpoint', () => {
  assert.equal(
    describeModel({ id: 'x', remote: false, price: { input: 0, output: 0 } }),
    'Free at this endpoint.',
  );
});

test('an unpriced remote model says the rate is not visible, rather than implying none', () => {
  const note = describeModel({ id: 'x', remote: true, host: 'https://ollama.com' });
  assert.match(note, /billed to that account/);
  assert.match(note, /Foreman cannot see/);
});

test('cost bars come from the real rate where there is one', () => {
  const rank = (output: number) => costRank({ id: 'x', remote: true, price: { input: 0, output } });
  assert.equal(rank(0), 0);
  assert.equal(rank(0.0000005), 1);   // $0.50/Mtok
  assert.equal(rank(0.000002), 2);    // $2
  assert.equal(rank(0.00001), 3);     // $10
  assert.equal(rank(0.00006), 4);     // $60
  // With no rate published, the old constant stands: local is free, remote is
  // a guess, and the note beside it says the rate is unknown.
  assert.equal(costRank({ id: 'x', remote: false }), 0);
  assert.equal(costRank({ id: 'x', remote: true }), 2);
});
