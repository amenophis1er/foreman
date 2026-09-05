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
import { ensureGateway, gatewayStatus, stopGateways } from './gateway.js';
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
