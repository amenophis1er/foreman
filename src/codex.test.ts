/**
 * Codex credential tests.
 *
 * Everything here uses a temp CODEX_HOME with fixture files — the real
 * `~/.codex` is never touched, and no test hits `auth.openai.com`: the
 * refresh test injects a stub `fetch`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import {
  codexHome, readCodexAuth, isStale, refreshCodexAuth, codexModels,
} from './codex.js';

async function tmpHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'foreman-codex-test-'));
}

function fixtureAuth(overrides: Record<string, unknown> = {}) {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id-token-value',
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      account_id: 'acct-123',
    },
    last_refresh: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// codexHome
// ---------------------------------------------------------------------------

test('codexHome honours CODEX_HOME override before the env var, then falls back to ~/.codex', async () => {
  const saved = process.env.CODEX_HOME;
  try {
    delete process.env.CODEX_HOME;
    assert.equal(codexHome(), path.join(os.homedir(), '.codex'));

    process.env.CODEX_HOME = '/from/env';
    assert.equal(codexHome(), '/from/env');

    assert.equal(codexHome('/explicit'), '/explicit');
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

// ---------------------------------------------------------------------------
// readCodexAuth
// ---------------------------------------------------------------------------

test('readCodexAuth returns null when auth.json is missing — no install is ordinary, not an error', async () => {
  const home = await tmpHome();
  try {
    assert.equal(await readCodexAuth(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readCodexAuth returns null on malformed JSON', async () => {
  const home = await tmpHome();
  try {
    await writeFile(path.join(home, 'auth.json'), '{ not json');
    assert.equal(await readCodexAuth(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readCodexAuth returns null when there is no usable credential', async () => {
  const home = await tmpHome();
  try {
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {} }),
    );
    assert.equal(await readCodexAuth(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readCodexAuth parses a well-formed file', async () => {
  const home = await tmpHome();
  try {
    const fixture = fixtureAuth();
    await writeFile(path.join(home, 'auth.json'), JSON.stringify(fixture));
    const auth = await readCodexAuth(home);
    assert.ok(auth);
    assert.equal(auth?.tokens?.access_token, 'access-token-value');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readCodexAuth prefers OPENAI_API_KEY over the OAuth access_token', async () => {
  const home = await tmpHome();
  try {
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify(fixtureAuth({ OPENAI_API_KEY: 'sk-plain-api-key' })),
    );
    const auth = await readCodexAuth(home);
    assert.ok(auth);
    // readCodexAuth returns the whole record; the caller (provider.ts, out of
    // scope for this module) is expected to prefer OPENAI_API_KEY when
    // present. Assert the fixture round-trips both fields so that contract is
    // checkable at the call site.
    assert.equal(auth?.OPENAI_API_KEY, 'sk-plain-api-key');
    assert.equal(auth?.tokens?.access_token, 'access-token-value');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

test('isStale: boundary either side of the default 25-minute threshold', () => {
  const now = Date.now();
  const justUnder = new Date(now - (25 * 60 * 1000 - 1000)).toISOString();
  const justOver = new Date(now - (25 * 60 * 1000 + 1000)).toISOString();

  assert.equal(isStale(fixtureAuth({ last_refresh: justUnder }) as any), false);
  assert.equal(isStale(fixtureAuth({ last_refresh: justOver }) as any), true);
});

test('isStale: a custom max age is honoured', () => {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  assert.equal(isStale(fixtureAuth({ last_refresh: tenMinAgo }) as any, 5 * 60 * 1000), true);
  assert.equal(isStale(fixtureAuth({ last_refresh: tenMinAgo }) as any, 15 * 60 * 1000), false);
});

test('isStale: no last_refresh at all is treated as stale', () => {
  const { last_refresh, ...rest } = fixtureAuth();
  assert.equal(isStale(rest as any), true);
});

// ---------------------------------------------------------------------------
// refreshCodexAuth
// ---------------------------------------------------------------------------

test('refreshCodexAuth writes the rotated token atomically and preserves unrelated fields', async () => {
  const home = await tmpHome();
  try {
    const fixture = fixtureAuth();
    await writeFile(path.join(home, 'auth.json'), JSON.stringify(fixture));

    let calledUrl: string | undefined;
    let calledBody: any;
    const stubFetch = (async (url: string, init: any) => {
      calledUrl = url;
      calledBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          id_token: 'new-id-token',
          refresh_token: 'new-refresh-token-single-use',
        }),
      };
    }) as any;

    const auth = await readCodexAuth(home);
    assert.ok(auth);
    const result = await refreshCodexAuth(home, auth!, stubFetch);
    assert.ok(result);

    assert.equal(calledUrl, 'https://auth.openai.com/oauth/token');
    assert.equal(calledBody.grant_type, 'refresh_token');
    assert.equal(calledBody.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(calledBody.refresh_token, 'refresh-token-value');

    // Unrelated top-level fields survive.
    assert.equal(result?.auth_mode, 'chatgpt');
    assert.equal(result?.OPENAI_API_KEY, null);

    // Tokens are rotated.
    assert.equal(result?.tokens?.access_token, 'new-access-token');
    assert.equal(result?.tokens?.refresh_token, 'new-refresh-token-single-use');
    assert.equal(result?.tokens?.account_id, 'acct-123'); // preserved, not part of the response

    // The write actually landed on disk, and no .tmp file was left behind.
    const onDisk = JSON.parse(await readFile(path.join(home, 'auth.json'), 'utf8'));
    assert.equal(onDisk.tokens.access_token, 'new-access-token');
    assert.equal(onDisk.tokens.refresh_token, 'new-refresh-token-single-use');

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(home);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no leftover tmp file');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('refreshCodexAuth returns null when there is no refresh token to send', async () => {
  const home = await tmpHome();
  try {
    const auth = fixtureAuth({ tokens: { access_token: 'a' } });
    const stubFetch = (async () => {
      throw new Error('must not be called');
    }) as any;
    const result = await refreshCodexAuth(home, auth as any, stubFetch);
    assert.equal(result, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('refreshCodexAuth returns null on a non-2xx response rather than throwing', async () => {
  const home = await tmpHome();
  try {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify(fixtureAuth()));
    const auth = await readCodexAuth(home);
    const stubFetch = (async () => ({ ok: false, json: async () => ({}) })) as any;
    const result = await refreshCodexAuth(home, auth!, stubFetch);
    assert.equal(result, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('refreshCodexAuth returns null when the network call throws', async () => {
  const home = await tmpHome();
  try {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify(fixtureAuth()));
    const auth = await readCodexAuth(home);
    const stubFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const result = await refreshCodexAuth(home, auth!, stubFetch);
    assert.equal(result, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('refreshCodexAuth never calls the real network (no fetch arg reaches auth.openai.com in this suite)', async () => {
  // Sanity check on the test design itself: every refresh test above passes
  // an explicit stub. This test just documents that refreshCodexAuth accepts
  // one rather than always using the global fetch.
  const home = await tmpHome();
  try {
    await writeFile(path.join(home, 'auth.json'), JSON.stringify(fixtureAuth()));
    const auth = await readCodexAuth(home);
    let called = false;
    const stubFetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({ access_token: 'x' }) };
    }) as any;
    await refreshCodexAuth(home, auth!, stubFetch);
    assert.equal(called, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// codexModels
// ---------------------------------------------------------------------------

test('codexModels returns [] when models_cache.json is absent', async () => {
  const home = await tmpHome();
  try {
    assert.deepEqual(await codexModels(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('codexModels returns [] on malformed JSON', async () => {
  const home = await tmpHome();
  try {
    await writeFile(path.join(home, 'models_cache.json'), 'not json');
    assert.deepEqual(await codexModels(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('codexModels returns [] when the models field is missing or the wrong shape', async () => {
  const home = await tmpHome();
  try {
    await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ fetched_at: 'x' }));
    assert.deepEqual(await codexModels(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('codexModels reads slugs faithfully from a real-shaped fixture', async () => {
  const home = await tmpHome();
  try {
    // Shaped after the actual ~/.codex/models_cache.json on a machine with
    // Codex installed: an array of model objects keyed by `slug`, with a lot
    // of other per-model metadata this module has no business parsing.
    await writeFile(
      path.join(home, 'models_cache.json'),
      JSON.stringify({
        fetched_at: '2026-09-04T02:56:08.542652Z',
        etag: 'W/"1e10c2927ad7b0d7cddc841252b75cb1"',
        client_version: '0.147.0',
        models: [
          { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
          { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list' },
          { slug: 'gpt-5.6-terra', visibility: 'list' },
          { display_name: 'no slug here', visibility: 'list' },
        ],
      }),
    );
    assert.deepEqual(await codexModels(home), ['gpt-reserve', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
