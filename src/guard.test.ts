import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { requestAllowed, pathPermitted } from './guard.js';

const PORT = 4177;
const TAILNET = { ip: '100.94.221.98', dnsName: 'laptop.tail1234.ts.net' };
const OPTS = { port: PORT, tailnet: TAILNET };

/** A request as the guard sees one: a method and a bag of headers. */
function req(method: string, headers: Record<string, string>) {
  return { method, headers: headers as http.IncomingHttpHeaders };
}

test('requestAllowed: the hosts Foreman answers to', () => {
  assert.deepEqual(requestAllowed(req('GET', { host: `localhost:${PORT}` }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('GET', { host: `127.0.0.1:${PORT}` }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('GET', { host: `[::1]:${PORT}` }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('GET', { host: `100.94.221.98:${PORT}` }), OPTS), { ok: true });
  // The MagicDNS name with Foreman's port, and with whatever port
  // `tailscale serve` put in front of it — including none at all (443).
  assert.deepEqual(requestAllowed(req('GET', { host: `laptop.tail1234.ts.net:${PORT}` }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('GET', { host: 'laptop.tail1234.ts.net' }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('GET', { host: 'laptop.tail1234.ts.net:8443' }), OPTS), { ok: true });
  // Case never matters in a host name.
  assert.deepEqual(requestAllowed(req('GET', { host: 'LapTop.Tail1234.TS.net' }), OPTS), { ok: true });
});

test('requestAllowed: an unrecognised or missing Host is 421 (DNS rebinding)', () => {
  assert.deepEqual(requestAllowed(req('GET', { host: `evil.example:${PORT}` }), OPTS), {
    ok: false, status: 421, error: 'unrecognised Host',
  });
  assert.deepEqual(requestAllowed(req('GET', {}), OPTS), {
    ok: false, status: 421, error: 'unrecognised Host',
  });
  // A neighbouring name is not the tailnet name.
  assert.equal(requestAllowed(req('GET', { host: 'notlaptop.tail1234.ts.net' }), OPTS).ok, false);
  // No tailnet: its address is not special.
  assert.equal(requestAllowed(req('GET', { host: `100.94.221.98:${PORT}` }), { port: PORT, tailnet: null }).ok, false);
});

test('requestAllowed: safe methods pass on Host alone, whatever the Origin', () => {
  const ok = req('GET', { host: `localhost:${PORT}`, origin: 'http://evil.example' });
  assert.deepEqual(requestAllowed(ok, OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('HEAD', { host: `localhost:${PORT}`, origin: 'http://evil.example' }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('OPTIONS', { host: `localhost:${PORT}`, origin: 'http://evil.example' }), OPTS), { ok: true });
  // Including the event stream, which is how the dashboard stays live.
  assert.deepEqual(requestAllowed(req('GET', { host: `127.0.0.1:${PORT}`, 'sec-fetch-site': 'cross-site' }), OPTS), { ok: true });
});

test('requestAllowed: an unsafe method with a foreign Origin is refused', () => {
  assert.deepEqual(requestAllowed(req('POST', { host: `localhost:${PORT}`, origin: 'http://evil.example' }), OPTS), {
    ok: false, status: 403, error: 'cross-site request refused',
  });
  // Right name, wrong port: a different origin to the browser and to us.
  assert.equal(requestAllowed(req('POST', { host: `localhost:${PORT}`, origin: 'http://localhost:9999' }), OPTS).ok, false);
  // Not a web origin at all.
  assert.equal(requestAllowed(req('POST', { host: `localhost:${PORT}`, origin: 'null' }), OPTS).ok, false);
  assert.equal(requestAllowed(req('POST', { host: `localhost:${PORT}`, origin: 'file://' }), OPTS).ok, false);
});

test('requestAllowed: an unsafe method from Foreman’s own page is allowed', () => {
  assert.deepEqual(requestAllowed(req('POST', { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('DELETE', { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }), OPTS), { ok: true });
  // The phone, through `tailscale serve` on 443: HTTPS, no port in the Origin.
  assert.deepEqual(requestAllowed(req('POST', { host: 'laptop.tail1234.ts.net', origin: 'https://laptop.tail1234.ts.net' }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('POST', { host: `100.94.221.98:${PORT}`, origin: `http://100.94.221.98:${PORT}` }), OPTS), { ok: true });
});

test('requestAllowed: with no Origin, Sec-Fetch-Site decides', () => {
  // curl, src/cli.ts, the Telegram paths and the tests: neither header.
  assert.deepEqual(requestAllowed(req('POST', { host: `127.0.0.1:${PORT}` }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('POST', { host: `localhost:${PORT}`, 'sec-fetch-site': 'same-origin' }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('POST', { host: `localhost:${PORT}`, 'sec-fetch-site': 'none' }), OPTS), { ok: true });
  assert.deepEqual(requestAllowed(req('POST', { host: `localhost:${PORT}`, 'sec-fetch-site': 'cross-site' }), OPTS), {
    ok: false, status: 403, error: 'cross-site request refused',
  });
  assert.equal(requestAllowed(req('POST', { host: `localhost:${PORT}`, 'sec-fetch-site': 'same-site' }), OPTS).ok, false);
});

test('requestAllowed: FOREMAN_BIND=all takes any Host, and Origin must match it', () => {
  const all = { port: PORT, tailnet: null, bindAll: true };
  assert.deepEqual(requestAllowed(req('GET', { host: '192.168.1.20:4177' }), all), { ok: true });
  assert.deepEqual(requestAllowed(req('GET', { host: 'foreman.lan' }), all), { ok: true });
  assert.deepEqual(requestAllowed(req('POST', { host: 'foreman.lan', origin: 'http://foreman.lan' }), all), { ok: true });
  assert.equal(requestAllowed(req('POST', { host: 'foreman.lan', origin: 'http://evil.example' }), all).ok, false);
  // Even wide open, a request with no Host at all is not one we can place.
  assert.equal(requestAllowed(req('GET', {}), all).ok, false);
});

test('pathPermitted: at a root, under one, and never through ..', () => {
  const roots = ['/Users/me/Projects', '/Users/me/work'];
  assert.equal(pathPermitted('/Users/me/Projects', roots), true);
  assert.equal(pathPermitted('/Users/me/Projects/foreman/src', roots), true);
  assert.equal(pathPermitted('/Users/me/work', roots), true);
  assert.equal(pathPermitted('/etc', roots), false);
  assert.equal(pathPermitted('/Users/me', roots), false);
  // A neighbour that merely shares a prefix is outside.
  assert.equal(pathPermitted('/Users/me/Projects-backup', roots), false);
  // Traversal is resolved before it is judged.
  assert.equal(pathPermitted('/Users/me/Projects/../../../etc/passwd', roots), false);
  assert.equal(pathPermitted('/Users/me/Projects/foreman/../other', roots), true);
  assert.equal(pathPermitted('/Users/me/Projects/foreman', []), false);
});
