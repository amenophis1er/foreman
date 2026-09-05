/**
 * Provider model tests.
 *
 * The bulk of these guard one thing: that no provider configuration can leave
 * an ambient Anthropic credential reachable while requests are redirected at
 * the gateway. That combination does not fail loudly — it succeeds, and sends
 * a real subscription token to somebody else's API. So it gets tested from
 * every direction rather than reasoned about once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import {
  ANTHROPIC_NATIVE_BASE_URL, GATEWAY_INVARIANT, gatewayBaseUrl, normalizeOpenAiBaseUrl,
  ownedConfigDir, providerEnv, providerFromLegacy, providerOf, providerProblem, resolveProvider,
} from './provider.js';
import type { ProviderRef } from './types.js';

const ROOT = '/tmp/foreman-test-root';

/** Runs `fn` with extra environment variables set, then restores them. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every credential a Claude Code install could pick up from the environment. */
const AMBIENT = {
  ANTHROPIC_API_KEY: 'sk-ant-a-real-user-key',
  ANTHROPIC_AUTH_TOKEN: 'a-real-auth-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-a-real-subscription-token',
};

// ---------------------------------------------------------------------------
// The leak guard
// ---------------------------------------------------------------------------

test('gateway wires never forward an ambient credential', async () => {
  const refs: ProviderRef[] = [
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434', label: 'Ollama' },
    { kind: 'openai-compatible', id: 'or', baseUrl: 'https://openrouter.ai/api', apiKeyEnv: 'TEST_OR_KEY' },
    { kind: 'codex', id: 'codex' },
  ];

  await withEnv({ ...AMBIENT, TEST_OR_KEY: 'sk-or-test' }, async () => {
    for (const ref of refs) {
      const resolved = await resolveProvider(ref, ROOT);
      // Codex has no login on a test machine; give it one so env-building runs.
      const p = { ...resolved, apiKey: resolved.apiKey ?? 'codex-token', problem: undefined };
      const { env } = providerEnv(p);
      assert.ok(env, `${ref.kind} must build an env`);

      const leaked = Object.values(AMBIENT);
      for (const [k, v] of Object.entries(env)) {
        assert.ok(
          !leaked.includes(v as string),
          `${ref.kind} leaked an ambient credential through ${k}`,
        );
      }
      assert.equal(env.ANTHROPIC_BASE_URL, gatewayBaseUrl(), `${ref.kind}: ${GATEWAY_INVARIANT}`);
      assert.ok(env.ANTHROPIC_API_KEY, `${ref.kind}: ${GATEWAY_INVARIANT}`);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, `${ref.kind} left the OAuth token set`);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, `${ref.kind} left the auth token set`);
    }
  });
});

test('a gateway wire with no credential throws rather than falling back', async () => {
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'x', baseUrl: 'https://example.test', apiKeyEnv: 'TEST_ABSENT_KEY' },
    ROOT,
  );
  await withEnv({ TEST_ABSENT_KEY: undefined, ...AMBIENT }, async () => {
    assert.throws(() => providerEnv(p), /gateway wire must set an explicit/);
  });
});

test('gateway providers never read a user Claude Code install', async () => {
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ROOT);
  assert.equal(p.configDir, ownedConfigDir(ROOT, 'ollama'));
  assert.ok(p.configDir.startsWith(ROOT), 'must live under the Foreman data root');
  const { env } = providerEnv(p);
  assert.equal(env?.CLAUDE_CONFIG_DIR, p.configDir);
});

test('an endpoint needing no key still satisfies the invariant', async () => {
  // A local Ollama has no credential, but leaving the key unset would let a
  // machine-wide Keychain login answer for it instead.
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ROOT);
  await withEnv(AMBIENT, async () => {
    const { env } = providerEnv(p);
    assert.ok(env?.ANTHROPIC_API_KEY);
    assert.ok(!Object.values(AMBIENT).includes(env!.ANTHROPIC_API_KEY as string));
  });
});

test('gateway wires pin every model alias, or workers 400', async () => {
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'or', baseUrl: 'https://openrouter.ai/api', model: 'gpt-5' }, ROOT);
  const { env } = providerEnv(p);
  assert.equal(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-5');
  assert.equal(env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'gpt-5');
  assert.equal(env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-5');
  assert.equal(env?.LLM_GATEWAY_DEFAULT_MODEL, 'gpt-5');
});

test('the gateway port avoids Ollama', () => {
  assert.notEqual(new URL(gatewayBaseUrl()).port, '11434');
});

// ---------------------------------------------------------------------------
// The native wire keeps its existing behaviour
// ---------------------------------------------------------------------------

test('claude-code inherits ambient credentials, and never sees a gateway', async () => {
  const p = await resolveProvider({ kind: 'claude-code', configDir: '/tmp/cc' }, ROOT);
  await withEnv(AMBIENT, async () => {
    const { env } = providerEnv(p);
    assert.equal(env?.CLAUDE_CONFIG_DIR, '/tmp/cc');
    assert.equal(env?.ANTHROPIC_API_KEY, AMBIENT.ANTHROPIC_API_KEY, 'inheritance is the point');
    assert.equal(env?.ANTHROPIC_BASE_URL, undefined, 'must not be redirected');
    assert.equal(env?.LLM_GATEWAY_MODE, undefined);
  });
});

test('ownLogin strips the inherited key so the stored login pays', async () => {
  const p = await resolveProvider({ kind: 'claude-code', configDir: '/tmp/cc', ownLogin: true }, ROOT);
  await withEnv(AMBIENT, async () => {
    const { env } = providerEnv(p);
    assert.equal(env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
});

test('an Anthropic API key displaces a machine-wide subscription', async () => {
  await withEnv({ ...AMBIENT, TEST_ANT_KEY: 'sk-ant-foreman-owned' }, async () => {
    const p = await resolveProvider(
      { kind: 'anthropic-api', id: 'work', apiKeyEnv: 'TEST_ANT_KEY' }, ROOT);
    const { env } = providerEnv(p);
    assert.equal(env?.ANTHROPIC_API_KEY, 'sk-ant-foreman-owned');
    assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'a subscription must not win instead');
    assert.equal(env?.ANTHROPIC_BASE_URL, ANTHROPIC_NATIVE_BASE_URL);
    assert.equal(env?.CLAUDE_CONFIG_DIR, ownedConfigDir(ROOT, 'work'));
  });
});

// ---------------------------------------------------------------------------
// Migration, resolution, reporting
// ---------------------------------------------------------------------------

test('records written before providers resolve exactly as before', () => {
  assert.deepEqual(providerOf({}), { kind: 'claude-code', configDir: undefined, executable: undefined, ownLogin: false });
  assert.deepEqual(
    providerOf({ claudeInstance: { configDir: '/a', executable: '/b', billing: 'own-login' } }),
    { kind: 'claude-code', configDir: '/a', executable: '/b', ownLogin: true },
  );
  assert.equal(providerFromLegacy({ billing: 'inherit' }).kind, 'claude-code');
  // An explicit provider wins over a legacy pin left beside it.
  assert.equal(
    providerOf({ provider: { kind: 'codex', id: 'c' }, claudeInstance: { configDir: '/a' } }).kind,
    'codex',
  );
});

test('a missing credential is reported, not thrown', async () => {
  await withEnv({ TEST_GONE: undefined }, async () => {
    const p = await resolveProvider({ kind: 'anthropic-api', id: 'x', apiKeyEnv: 'TEST_GONE' }, ROOT);
    assert.match(providerProblem(p) ?? '', /TEST_GONE/);
  });
});

test('codex reads the login the CLI stored, and says so when there is none', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'foreman-codex-'));
  const missing = await resolveProvider({ kind: 'codex', id: 'c', codexHome: home }, ROOT);
  assert.match(missing.problem ?? '', /codex login/);

  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: 'codex-access-token', account_id: 'acct-1' },
  }));
  const found = await resolveProvider({ kind: 'codex', id: 'c', codexHome: home }, ROOT);
  assert.equal(found.problem, undefined);
  assert.equal(found.apiKey, 'codex-access-token');
  assert.equal(found.wire, 'gateway-codex');
  assert.ok(!found.label.includes('codex-access-token'), 'a label must never carry a secret');
});

test('base URLs are normalised the way people paste them', () => {
  for (const input of ['https://api.openai.com/v1', 'https://api.openai.com/', 'api.openai.com']) {
    assert.equal(normalizeOpenAiBaseUrl(input), 'https://api.openai.com');
  }
  assert.equal(normalizeOpenAiBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434',
    'a local http endpoint must not be upgraded to https');
});

test('gateway providers refuse to dispatch until the gateway exists', async () => {
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ROOT);
  assert.match(providerProblem(p) ?? '', /not built yet/);
});
