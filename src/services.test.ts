import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ServiceRegistry, listeningPid, parseServicePath, portOpen, proxyToService, servicePath, servicesHandler, stopService } from './services.js';
import { spawn } from 'node:child_process';
import { requestAllowed } from './guard.js';

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

test('the services port serves only /svc/ — everything else is a 404', async () => {
  const registry = new ServiceRegistry();
  // The guard checks the Host against the port it is given, and the port is
  // only known after listen(), so it is read out of a box the listener fills.
  let port = 0;
  const server = http.createServer(servicesHandler({
    registry,
    allowed: (req) => requestAllowed(req, { port, tailnet: null }),
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  try {
    const other = await fetch(`http://127.0.0.1:${port}/anything`);
    assert.equal(other.status, 404);
    assert.deepEqual(await other.json(), { error: 'not found' });

    const undeclared = await fetch(`http://127.0.0.1:${port}/svc/run-1/3000/`);
    assert.equal(undeclared.status, 404);
    assert.deepEqual(await undeclared.json(), { error: 'no such service' });

    // And the guard still runs first: a rebound Host never reaches the proxy.
    // Raw http, not fetch — undici refuses to let a caller set Host.
    const rebound = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/svc/run-1/3000/', headers: { host: 'evil.example' } },
        (res2) => { res2.resume(); resolve(res2.statusCode ?? 0); });
      r.on('error', reject);
      r.end();
    });
    assert.equal(rebound, 421);
  } finally {
    server.close();
  }
});

/** A child process holding a port, the way a crew's dev server does. */
async function server(): Promise<{ pid: number; port: number; kill: () => void }> {
  const child = spawn(process.execPath, ['-e',
    "const s=require('http').createServer((_,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once('data', (b) => resolve(Number(String(b).trim())));
    child.once('error', reject);
    setTimeout(() => reject(new Error('the test server never reported a port')), 5000);
  });
  return { pid: child.pid as number, port, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

test('listeningPid names the process holding a port, and nobody for a free one', async () => {
  const s = await server();
  try {
    assert.equal(await listeningPid(s.port), s.pid);
  } finally { s.kill(); }
  // Once it is gone the port is nobody's.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await listeningPid(s.port), null);
});

test('stopService stops the recorded process, and refuses every other case', async () => {
  const s = await server();
  try {
    assert.deepEqual(await stopService(s.port, undefined), {
      ok: false, reason: 'Foreman did not record which process this was, so it will not kill anything.',
    }, 'no recorded pid means no killing');

    const wrong = await stopService(s.port, s.pid + 100000);
    assert.equal(wrong.ok, false, 'a port held by someone else is left alone');
    assert.match((wrong as { reason: string }).reason, /not the/);
    assert.equal(await portOpen(s.port), true, 'and the refusal really did leave it running');

    const stopped = await stopService(s.port, s.pid);
    assert.equal(stopped.ok, true);
    assert.equal(await portOpen(s.port), false);

    const gone = await stopService(s.port, s.pid);
    assert.equal(gone.ok, false, 'stopping twice is not an error worth pretending about');
  } finally { s.kill(); }
});
