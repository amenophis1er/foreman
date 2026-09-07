import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { MEMORY_CAP_BYTES, memorySection, readMemory, scrubSecrets, writeMemory } from './memory.js';

test('scrubSecrets removes what looks like a credential and keeps the line readable', () => {
  const r = scrubSecrets([
    'Run tests with: npm test',
    'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    'GitHub token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 is in the CI',
    'aws: AKIAIOSFODNN7EXAMPLE',
    'Bearer: abcdefghijklmnopqrstuvwxyz1234567890',
    'The port 8420 is taken by the preview server',
  ].join('\n'));
  assert.ok(r.redacted >= 4, String(r.redacted));
  assert.match(r.text, /^Run tests with: npm test$/m);
  assert.match(r.text, /^ANTHROPIC_API_KEY=\[redacted\]$/m);
  assert.doesNotMatch(r.text, /ghp_ABCDEF/);
  assert.doesNotMatch(r.text, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(r.text, /port 8420 is taken/);
});

test('writeMemory: full-page replace, secrets stripped, capped at a page or two, then readMemory sees it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-'));
  const w = await writeMemory(dir, '# Notes\n- tests: npm test\n- API_TOKEN=abcdefghijklmnop1234\n');
  assert.equal(w.redacted, 1); assert.equal(w.trimmed, false);
  const m = await readMemory(dir);
  assert.match(m.text, /- tests: npm test\n- API_TOKEN=\[redacted\]\n$/);
  assert.ok(m.updatedAt);
  const big = await writeMemory(dir, Array.from({ length: 2000 }, (_, i) => `- line ${i} about the project`).join('\n'));
  assert.equal(big.trimmed, true);
  assert.ok(big.bytes <= MEMORY_CAP_BYTES);
  assert.ok((await readFile(path.join(dir, '.foreman', 'MEMORY.md'), 'utf8')).endsWith('\n'));
});

test('memorySection: the director is told to write an empty memory; workers and the planner get nothing for empty; all get the page otherwise', () => {
  assert.match(memorySection('', 'director'), /empty\. Before you finish, write it with mcp__foreman__remember/);
  assert.equal(memorySection('', 'worker'), '');
  assert.equal(memorySection('', 'planner'), '');
  const s = memorySection('- port 8420 is taken', 'worker');
  assert.match(s, /PROJECT MEMORY — what earlier crews learned/);
  assert.match(s, /---\n- port 8420 is taken\n---/);
  assert.match(memorySection('x', 'planner'), /Ground your advice in it/);
});
