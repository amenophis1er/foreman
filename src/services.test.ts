import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ServiceRegistry, parseServicePath, portOpen, proxyToService, servicePath } from './services.js';

test('service paths round-trip and reject junk', () => {
  assert.equal(servicePath('run-1', 8934), '/svc/run-1/8934/');
  assert.deepEqual(parseServicePath('/svc/run-1/8934/'), { runId: 'run-1', port: 8934, rest: '/' });
  assert.deepEqual(parseServicePath('/svc/run-1/8934/css/a.css'), { runId: 'run-1', port: 8934, rest: '/css/a.css' });
  assert.deepEqual(parseServicePath('/svc/run-1/8934'), { runId: 'run-1', port: 8934, rest: '/' });
  assert.equal(parseServicePath('/svc/run-1/abc/'), null);
  assert.equal(parseServicePath('/svc/run-1/70000/'), null);
  assert.equal(parseServicePath('/svcx/run-1/80/'), null);
});

test('registry: declared pairs only, one entry per port, lookup by port', () => {
  const r = new ServiceRegistry();
  const a = r.register('run-1', 8934, 'preview');
  assert.equal(a.path, '/svc/run-1/8934/');
  r.register('run-1', 8934, 'preview again');
  assert.equal(r.list('run-1').length, 1);
  assert.equal(r.list('run-1')[0].label, 'preview again');
  assert.equal(r.has('run-1', 8934), true);
  assert.equal(r.has('run-1', 9000), false);
  assert.deepEqual(r.runsFor(8934), ['run-1']);
});

test('proxyToService streams a response and reports a dead port as 502', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-seen-prefix': String(req.headers['x-forwarded-prefix']) });
    res.end(`hello ${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as { port: number }).port;
  assert.equal(await portOpen(port), true);
  const front = http.createServer((req, res) => proxyToService(req, res, port, '/a/b', '?x=1', '/svc/run-1/' + port + '/'));
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  const fport = (front.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${fport}/anything`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello /a/b?x=1');
    assert.equal(r.headers.get('x-seen-prefix'), '/svc/run-1/' + port + '/');
    upstream.close();
    await new Promise((r2) => setTimeout(r2, 50));
    const dead = await fetch(`http://127.0.0.1:${fport}/anything`);
    assert.equal(dead.status, 502);
    assert.match(await dead.text(), /Nothing is answering/);
    assert.equal(await portOpen(port), false);
  } finally {
    front.close();
  }
});
