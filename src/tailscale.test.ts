import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTailscaleIp, parseTailscaleStatus, tailnetFromInterfaces, tailnetUrl } from './tailscale.js';

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
