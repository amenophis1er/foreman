import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTailscaleIp, parseTailscaleStatus, tailnetFromInterfaces, tailnetUrl, parseServeStatus, serveHint } from './tailscale.js';

test('isTailscaleIp: only 100.64.0.0/10', () => {
  assert.equal(isTailscaleIp('100.94.221.98'), true);
  assert.equal(isTailscaleIp('100.64.0.1'), true);
  assert.equal(isTailscaleIp('100.127.255.255'), true);
  assert.equal(isTailscaleIp('100.128.0.1'), false);
  assert.equal(isTailscaleIp('100.63.0.1'), false);
  assert.equal(isTailscaleIp('192.168.1.10'), false);
});

test('parseTailscaleStatus: running with an address and a name; stopped is null', () => {
  const t = parseTailscaleStatus({ BackendState: 'Running', Self: { DNSName: 'laptop.tail1234.ts.net.', TailscaleIPs: ['100.94.221.98', 'fd7a::1'] } });
  assert.deepEqual(t, { ip: '100.94.221.98', dnsName: 'laptop.tail1234.ts.net' });
  assert.equal(parseTailscaleStatus({ BackendState: 'Stopped', Self: { TailscaleIPs: ['100.94.221.98'] } }), null);
  assert.equal(parseTailscaleStatus({ BackendState: 'Running', Self: { TailscaleIPs: [] } }), null);
  assert.equal(parseTailscaleStatus(null), null);
  assert.equal(tailnetUrl(t!, 4177), 'http://laptop.tail1234.ts.net:4177');
  assert.equal(tailnetUrl({ ip: '100.1.2.3' }, 4177), 'http://100.1.2.3:4177');
});

test('tailnetFromInterfaces: finds the CGNAT address, ignores loopback and LAN', () => {
  const t = tailnetFromInterfaces({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
    en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false } as never],
    utun4: [{ address: '100.94.221.98', family: 'IPv4', internal: false } as never],
  });
  assert.deepEqual(t, { ip: '100.94.221.98' });
  assert.equal(tailnetFromInterfaces({ en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false } as never] }), null);
});

test('parseServeStatus finds the HTTPS port that proxies to Foreman, and the ports already taken', () => {
  const json = {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: {
      'laptop.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7717' } } },
      'laptop.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4177' } } },
    },
  };
  assert.deepEqual(parseServeStatus(json, 4177), { httpsPort: 8443, httpsInUse: [443, 8443] });
  assert.deepEqual(parseServeStatus(json, 4178), { httpsPort: undefined, httpsInUse: [443, 8443] });
  assert.deepEqual(parseServeStatus({}, 4177), { httpsPort: undefined, httpsInUse: [] });
});

test('tailnetUrl prefers the served HTTPS origin, port only when not 443', () => {
  const t = { ip: '100.64.0.1', dnsName: 'laptop.tail1234.ts.net' };
  assert.equal(tailnetUrl({ ...t, httpsPort: 443 }, 4177), 'https://laptop.tail1234.ts.net');
  assert.equal(tailnetUrl({ ...t, httpsPort: 8443 }, 4177), 'https://laptop.tail1234.ts.net:8443');
  assert.equal(tailnetUrl(t, 4177), 'http://laptop.tail1234.ts.net:4177');
});

test('serveHint picks 443 when free, else the next conventional port', () => {
  assert.equal(serveHint(4177), 'tailscale serve --bg 4177');
  assert.equal(serveHint(4177, [443]), 'tailscale serve --bg --https=8443 4177');
  assert.equal(serveHint(4177, [443, 8443]), 'tailscale serve --bg --https=10000 4177');
});
