import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { compareVersions, latestVersion } from './update.js';

test('compareVersions: numeric, not lexical; pre-release below release', () => {
  assert.equal(compareVersions('0.1.2', '0.1.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.1.2', '0.1.2'), 0);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
});

test('latestVersion: reads the latest tag; a silent registry is null, not an error', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/@x%2Fy/latest') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '9.9.9' })); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    assert.equal(await latestVersion('@x/y', 2000, `http://127.0.0.1:${port}`), '9.9.9');
    assert.equal(await latestVersion('@x/missing', 2000, `http://127.0.0.1:${port}/nope`), null);
  } finally { srv.close(); }
  assert.equal(await latestVersion('@x/y', 200, 'http://127.0.0.1:9'), null);
});
