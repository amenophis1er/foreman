/**
 * Gateway supervisor tests.
 *
 * These drive a real child process against a stub upstream rather than mocking
 * the spawn: the things that break here — a port that never binds, a gateway
 * that dies, a credential that does or does not reach the upstream — are all
 * properties of an actual process, and a mock would assert the design back at
 * itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  ensureGateway, gatewayStatus, gatewayUsage, reapNow, releaseGateways, stopGateways,
} from './gateway.js';
import { providerEnv, resolveProvider } from './provider.js';

const ROOT = '/tmp/foreman-gateway-test';

/** A minimal OpenAI-compatible endpoint that records what it was sent. */
function stubUpstream(): Promise<{
  url: string; seen: Array<{ auth?: string; body: any }>; close: () => Promise<void>;
}> {
  const seen: Array<{ auth?: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not json */ }
      seen.push({ auth: req.headers.authorization as string | undefined, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', model: body?.model ?? 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('a gateway starts, translates, and carries the agent credential through', async (t) => {
  const upstream = await stubUpstream();
  t.after(async () => { stopGateways(); await upstream.close(); });

  const provider = await resolveProvider(
    { kind: 'openai-compatible', id: 'stub', baseUrl: upstream.url, apiKeyEnv: 'TEST_GW_KEY' },
    ROOT,
  );
  process.env.TEST_GW_KEY = 'sk-stub-key';
  const withKey = { ...(await resolveProvider(
    { kind: 'openai-compatible', id: 'stub', baseUrl: upstream.url, apiKeyEnv: 'TEST_GW_KEY' }, ROOT)) };
  assert.equal(withKey.problem, undefined);
  assert.equal(provider.wire, 'gateway-openai');

  const gatewayUrl = await ensureGateway(withKey);
  assert.match(gatewayUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(gatewayUrl).port, '11434', 'must not squat Ollama’s port');

  // Speak to it the way the SDK does: Anthropic Messages in, x-api-key header.
  const res = await fetch(`${gatewayUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-stub-key' },
    body: JSON.stringify({
      model: 'gpt-5', max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;

  // Out the far side it must look like an Anthropic response.
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.content[0].text, 'pong');

  // And the upstream must have been spoken to in OpenAI's dialect, holding the
  // credential the agent sent — not one the supervisor knows.
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].auth, 'Bearer sk-stub-key');
  assert.equal(upstream.seen[0].body.messages[0].content, 'ping');
});

test('the same upstream is served by one process, a different one by another', async (t) => {
  const a = await stubUpstream();
  const b = await stubUpstream();
  t.after(async () => { stopGateways(); await a.close(); await b.close(); });

  const mk = (url: string, id: string) =>
    resolveProvider({ kind: 'openai-compatible', id, baseUrl: url }, ROOT);

  const first = await ensureGateway(await mk(a.url, 'a'));
  const same = await ensureGateway(await mk(a.url, 'a2'));
  const other = await ensureGateway(await mk(b.url, 'b'));

  assert.equal(first, same, 'one upstream, one process');
  assert.notEqual(first, other, 'two upstreams cannot share a process');
  assert.equal(gatewayStatus().length, 2);
  assert.ok(gatewayStatus().every((g) => !('apiKey' in g)), 'status must never carry a secret');
});

test('an agent env built for a gateway points at that gateway', async (t) => {
  const upstream = await stubUpstream();
  t.after(async () => { stopGateways(); await upstream.close(); });

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'e2e', baseUrl: upstream.url, model: 'llama3' }, ROOT);
  const url = await ensureGateway(p);
  const { env } = providerEnv(p, url);
  assert.equal(env?.ANTHROPIC_BASE_URL, url);
  assert.ok(env?.ANTHROPIC_API_KEY, 'the invariant still holds through the supervisor');
  assert.equal(env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'llama3');
});

test('a gateway a run still holds is never reaped, however quiet', async (t) => {
  const upstream = await stubUpstream();
  t.after(async () => { stopGateways(); await upstream.close(); });

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'held', baseUrl: upstream.url }, ROOT);

  // Idle time moves when an agent env is BUILT, which happens once at
  // dispatch — not when requests flow. Reaping on that alone pulled the proxy
  // out from under a thirty-minute mission ten minutes in, and every call
  // after it failed with a refused connection.
  const url = await ensureGateway(p, 'run-1');
  assert.equal(gatewayStatus().length, 1);

  reapNow(Date.now() + 60 * 60_000);
  assert.equal(gatewayStatus().length, 1, 'held by run-1, so it must survive');

  const stillThere = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ model: 'm', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(stillThere.status, 200, 'a held gateway still answers');

  releaseGateways('run-1');
  reapNow(Date.now() + 60 * 60_000);
  assert.equal(gatewayStatus().length, 0, 'released and idle, so it goes');
});

test('two runs holding one gateway: the first to finish does not kill it', async (t) => {
  const upstream = await stubUpstream();
  t.after(async () => { stopGateways(); await upstream.close(); });

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'shared', baseUrl: upstream.url }, ROOT);
  await ensureGateway(p, 'run-a');
  await ensureGateway(p, 'run-b');

  releaseGateways('run-a');
  reapNow(Date.now() + 60 * 60_000);
  assert.equal(gatewayStatus().length, 1, 'run-b still needs it');

  releaseGateways('run-b');
  reapNow(Date.now() + 60 * 60_000);
  assert.equal(gatewayStatus().length, 0);
});

test('a run key on the path is stripped, attributed, and never sent upstream', async (t) => {
  // The mechanism the whole ledger rests on: Foreman points an agent at
  // `.../run/<key>`, the SDK preserves that prefix (measured — it sends
  // `POST /run/<key>/v1/messages`), and the gateway must both count against
  // the key AND hand the upstream the path it expects.
  const upstream = await stubUpstream();
  t.after(async () => { stopGateways(); await upstream.close(); });

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ledger', baseUrl: upstream.url }, ROOT);
  const url = await ensureGateway(p, 'run-x');

  const ask = (path: string) => fetch(`${url}${path}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });

  const res = await ask('/run/mission-1.0');
  assert.equal(res.status, 200, 'a keyed request is served exactly like an unkeyed one');
  const body = await res.json() as { content: Array<{ text: string }> };
  assert.equal(body.content[0].text, 'pong', 'the agent must not be able to tell it was counted');

  // The upstream sees its own API, not Foreman's routing.
  assert.equal(upstream.seen.length, 1);

  const totals = await gatewayUsage('mission-1.0');
  assert.ok(totals, 'the key should have been attributed');
  assert.equal(totals!.inputTokens, 3, 'the stub reports 3 prompt tokens');
  assert.equal(totals!.outputTokens, 1);
  assert.equal(totals!.calls, 1);

  // A different attempt of the same run is a different bucket.
  assert.equal(await gatewayUsage('mission-1.1'), null);
});

test('an unkeyed request is still served, just not counted', async (t) => {
  // A gateway that refused traffic it could not label would turn bookkeeping
  // into an outage.
  const upstream = await stubUpstream();
  t.after(async () => { stopGateways(); await upstream.close(); });

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'unkeyed', baseUrl: upstream.url }, ROOT);
  const url = await ensureGateway(p, 'run-y');

  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
    body: JSON.stringify({ model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).content[0].text, 'pong');
});
