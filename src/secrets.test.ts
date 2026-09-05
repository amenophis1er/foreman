/**
 * Secret store tests.
 *
 * This is the first thing Foreman keeps rather than reads, so the properties
 * under test are the ones that make that defensible: the key is only ever on
 * disk at 0600, it never lands anywhere else, and nothing returns it except
 * the one function whose job that is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { deleteSecret, getSecret, hasSecret, putSecret } from './secrets.js';
import { ownedConfigDir, resolveProvider } from './provider.js';

async function tmpRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'foreman-secrets-'));
}

test('a stored key round-trips, and only through getSecret', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(await hasSecret(root, 'p1'), false);
  assert.equal(await getSecret(root, 'p1'), null);

  await putSecret(root, 'p1', 'sk-secret-value');
  assert.equal(await hasSecret(root, 'p1'), true);
  assert.equal(await getSecret(root, 'p1'), 'sk-secret-value');
});

test('the key file is 0600 and lives only in the provider’s own dir', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await putSecret(root, 'p1', 'sk-secret-value');
  const file = path.join(ownedConfigDir(root, 'p1'), 'key');
  const st = await stat(file);
  assert.equal(st.mode & 0o777, 0o600, 'a credential must not be group- or world-readable');

  // Nothing was left behind by the tmp+rename, which would be a copy of the
  // key at whatever mode the OS chose.
  const left = await readdir(path.dirname(file));
  assert.deepEqual(left, ['key']);
});

test('replacing a key leaves no trace of the old one', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await putSecret(root, 'p1', 'sk-first');
  await putSecret(root, 'p1', 'sk-second');
  assert.equal(await getSecret(root, 'p1'), 'sk-second');

  const dir = ownedConfigDir(root, 'p1');
  const files = await readdir(dir);
  assert.deepEqual(files, ['key']);
  const contents = await readFile(path.join(dir, 'key'), 'utf8');
  assert.ok(!contents.includes('sk-first'));
});

test('deleting is idempotent — the caller wanted it gone', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await deleteSecret(root, 'never-existed'); // must not throw
  await putSecret(root, 'p1', 'sk-x');
  await deleteSecret(root, 'p1');
  await deleteSecret(root, 'p1');
  assert.equal(await hasSecret(root, 'p1'), false);
  assert.equal(await getSecret(root, 'p1'), null);
});

test('keys never reach projects.json', async (t) => {
  // The file people copy between machines and paste into issues.
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, 'projects.json'), JSON.stringify([
    { id: 'x', provider: { kind: 'openai-compatible', id: 'p1', baseUrl: 'https://api.openai.com' } },
  ]));
  await putSecret(root, 'p1', 'sk-must-not-appear');
  const projects = await readFile(path.join(root, 'projects.json'), 'utf8');
  assert.ok(!projects.includes('sk-must-not-appear'));
});

test('a stored key beats the environment, and its absence falls back', async (t) => {
  const root = await tmpRoot();
  t.after(() => {
    delete process.env.TEST_SECRET_FALLBACK;
    return rm(root, { recursive: true, force: true });
  });
  process.env.TEST_SECRET_FALLBACK = 'sk-from-env';

  const ref = {
    kind: 'openai-compatible' as const, id: 'p1',
    baseUrl: 'https://api.openai.com', apiKeyEnv: 'TEST_SECRET_FALLBACK',
  };

  // Nothing stored yet: the named variable answers.
  assert.equal((await resolveProvider(ref, root)).apiKey, 'sk-from-env');

  // Stored wins — it is the deliberate, per-provider choice.
  await putSecret(root, 'p1', 'sk-stored');
  assert.equal((await resolveProvider(ref, root)).apiKey, 'sk-stored');

  await deleteSecret(root, 'p1');
  assert.equal((await resolveProvider(ref, root)).apiKey, 'sk-from-env');
});

test('an endpoint that needs a key and has none reports it without naming one', async (t) => {
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'p1', baseUrl: 'https://api.openai.com', needsKey: true },
    root,
  );
  assert.match(p.problem ?? '', /needs a key/);
  assert.equal(p.apiKey, undefined);

  await putSecret(root, 'p1', 'sk-now-stored');
  const ok = await resolveProvider(
    { kind: 'openai-compatible', id: 'p1', baseUrl: 'https://api.openai.com', needsKey: true },
    root,
  );
  assert.equal(ok.problem, undefined);
  assert.equal(ok.apiKey, 'sk-now-stored');
  assert.ok(!ok.label.includes('sk-now-stored'), 'a label must never carry a secret');
});

test('a keyless endpoint still needs no key at all', async (t) => {
  // A local Ollama: `needsKey` absent and no env var named. It gets the
  // placeholder that satisfies the gateway invariant, not a missing-key error.
  const root = await tmpRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, root);
  assert.equal(p.problem, undefined);
  assert.ok(p.apiKey);
});
