import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchdPlist, servicePath, systemdUnit } from './cli.js';

test('launchdPlist: label, node + bin + start, env, keepalive, one log', () => {
  const p = launchdPlist({ label: 'dev.foreman.server', node: '/usr/local/bin/node', bin: '/x/bin/foreman.mjs', home: '/Users/a/.foreman', logDir: '/Users/a/.foreman/logs', env: { PATH: '/a:/b', PORT: '4177', X: 'a<b&c' } });
  assert.match(p, /<key>Label<\/key><string>dev\.foreman\.server<\/string>/);
  assert.match(p, /<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/x\/bin\/foreman\.mjs<\/string>\s*<string>start<\/string>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /<key>X<\/key><string>a&lt;b&amp;c<\/string>/);
  assert.match(p, /server\.log/);
});

test('systemdUnit: restart always, env lines, default target', () => {
  const u = systemdUnit({ node: '/usr/bin/node', bin: '/x/bin/foreman.mjs', home: '/home/a/.foreman', env: { PORT: '4177' } });
  assert.match(u, /ExecStart=\/usr\/bin\/node \/x\/bin\/foreman\.mjs start/);
  assert.match(u, /Restart=always/);
  assert.match(u, /Environment=PORT=4177/);
  assert.match(u, /WantedBy=default\.target/);
});

test('servicePath: node dir first, usual prefixes, no duplicates', () => {
  const p = servicePath('/opt/homebrew/Cellar/node/26/bin/node', '/usr/bin:/bin').split(':');
  assert.equal(p[0], '/opt/homebrew/Cellar/node/26/bin');
  assert.ok(p.includes('/opt/homebrew/bin') && p.includes('/usr/local/bin'));
  assert.equal(new Set(p).size, p.length);
});
