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
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import {
  ANTHROPIC_NATIVE_BASE_URL, GATEWAY_INVARIANT, normalizeOpenAiBaseUrl,
  ownedConfigDir, providerEnv, providerFromLegacy, providerOf, providerProblem, resolveProvider, roleCost, withRoleModel,
} from './provider.js';
import type { ProviderRef } from './types.js';

/** Stands in for a running gateway; the supervisor's own port is dynamic. */
const GW = 'http://127.0.0.1:54321';

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
      const { env } = providerEnv(p, GW);
      assert.ok(env, `${ref.kind} must build an env`);

      const leaked = Object.values(AMBIENT);
      for (const [k, v] of Object.entries(env)) {
        assert.ok(
          !leaked.includes(v as string),
          `${ref.kind} leaked an ambient credential through ${k}`,
        );
      }
      assert.equal(env.ANTHROPIC_BASE_URL, GW, `${ref.kind}: ${GATEWAY_INVARIANT}`);
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
    assert.throws(() => providerEnv(p, GW), /gateway wire must set an explicit/);
  });
});

test('gateway providers never read a user Claude Code install', async () => {
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ROOT);
  assert.equal(p.configDir, ownedConfigDir(ROOT, 'ollama'));
  assert.ok(p.configDir.startsWith(ROOT), 'must live under the Foreman data root');
  const { env } = providerEnv(p, GW);
  assert.equal(env?.CLAUDE_CONFIG_DIR, p.configDir);
});

test('an endpoint needing no key still satisfies the invariant', async () => {
  // A local Ollama has no credential, but leaving the key unset would let a
  // machine-wide Keychain login answer for it instead.
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ROOT);
  await withEnv(AMBIENT, async () => {
    const { env } = providerEnv(p, GW);
    assert.ok(env?.ANTHROPIC_API_KEY);
    assert.ok(!Object.values(AMBIENT).includes(env!.ANTHROPIC_API_KEY as string));
  });
});

test('gateway wires pin every model alias, or workers 400', async () => {
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'or', baseUrl: 'https://openrouter.ai/api', model: 'gpt-5' }, ROOT);
  const { env } = providerEnv(p, GW);
  assert.equal(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-5');
  assert.equal(env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'gpt-5');
  assert.equal(env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-5');
  assert.equal(env?.LLM_GATEWAY_DEFAULT_MODEL, 'gpt-5');
});

test('a gateway wire with no gateway running refuses to build an env', async () => {
  // The supervisor allocates the port, so an env built without one would point
  // the agent at nothing — or, worse, at whatever else answers on a guess.
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ROOT);
  assert.throws(() => providerEnv(p), /gateway wire must set an explicit/);
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

test('a scheme-less local host gets http, a public one gets https', () => {
  // Typing the host and port is how a person adds a local daemon, and
  // defaulting that to https guarantees a handshake failure on the first call.
  for (const local of ['127.0.0.1:11434', 'localhost:11434', 'box:11434', 'nas.local:11434',
    '192.168.1.9:11434', '10.0.0.4:11434', '172.20.1.1:11434']) {
    assert.equal(normalizeOpenAiBaseUrl(local).slice(0, 5), 'http:', `${local} should not be https`);
  }
  for (const remote of ['api.openai.com', 'openrouter.ai/api', 'ollama.com']) {
    assert.equal(normalizeOpenAiBaseUrl(remote).slice(0, 6), 'https:', `${remote} should be https`);
  }
  // An explicit scheme always wins, in both directions.
  assert.equal(normalizeOpenAiBaseUrl('https://box:11434'), 'https://box:11434');
});

test('a resolvable gateway provider reports no problem', async () => {
  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ROOT);
  assert.equal(providerProblem(p), null);
});

// ---------------------------------------------------------------------------
// What each provider's spend actually is
// ---------------------------------------------------------------------------

test('each provider kind resolves to the cost basis that is true of it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-basis-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const basis = async (ref: ProviderRef) => (await resolveProvider(ref, root)).costBasis;

  // Anthropic prices its own tokens, so the SDK figure is the real one.
  assert.equal(await basis({ kind: 'claude-code' }), 'priced');
  assert.equal(await basis({
    kind: 'anthropic-api', id: 'a', apiKeyEnv: 'NOPE',
  }), 'priced');

  // A ChatGPT plan is drawn down rather than billed per token — real, finite,
  // and not something Foreman can put a number on.
  assert.equal(await basis({ kind: 'codex', id: 'c', codexHome: path.join(root, 'codex') }), 'unpriced');

  // The operator's own hardware, whether on this machine or their LAN.
  assert.equal(await basis({
    kind: 'openai-compatible', id: 'o', baseUrl: 'http://127.0.0.1:11434',
  }), 'free');
  assert.equal(await basis({
    kind: 'openai-compatible', id: 'o', baseUrl: 'http://192.168.1.9:11434',
  }), 'free');

  // Somebody's paid service. Unpriced, never free — guessing free about a
  // billed endpoint is the error that costs money.
  assert.equal(await basis({
    kind: 'openai-compatible', id: 'o', baseUrl: 'https://openrouter.ai/api',
  }), 'unpriced');
  assert.equal(await basis({
    kind: 'openai-compatible', id: 'o', baseUrl: 'https://ollama.com',
  }), 'unpriced');
});

test('the deprecated metered boolean never disagrees with the basis', async (t) => {
  // Both are written by one helper precisely so they cannot drift; if that
  // ever stops being true, a run's enforcement and its display disagree.
  const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-basis-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const refs: ProviderRef[] = [
    { kind: 'claude-code' },
    { kind: 'anthropic-api', id: 'a', apiKeyEnv: 'NOPE' },
    { kind: 'codex', id: 'c', codexHome: path.join(root, 'codex') },
    { kind: 'openai-compatible', id: 'o', baseUrl: 'http://127.0.0.1:11434' },
    { kind: 'openai-compatible', id: 'p', baseUrl: 'https://openrouter.ai/api' },
  ];
  for (const ref of refs) {
    const p = await resolveProvider(ref, root);
    assert.equal(p.metered, p.costBasis === 'priced', `${ref.kind} drifted`);
  }
});

test('a cloud model behind a local daemon is not free', async (t) => {
  // The configuration Foreman is most often used in, and the one the endpoint
  // alone gets wrong: `glm-…:cloud` reaches 127.0.0.1, but runs on paid
  // servers the daemon signs for with the operator's own Ollama account.
  const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-refine-'));
  const daemon = http.createServer((req, res) => {
    if (req.url !== '/api/tags') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [
      { name: 'qwen3:8b', details: { parameter_size: '8B' } },
      { name: 'glm-5.3-flash:cloud', remote_model: true, remote_host: 'https://ollama.com' },
    ] }));
  });
  await new Promise<void>((r) => daemon.listen(0, '127.0.0.1', r));
  const port = (daemon.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((r) => daemon.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });

  const p = await resolveProvider(
    { kind: 'openai-compatible', id: 'o', baseUrl: `http://127.0.0.1:${port}` }, root);
  assert.equal(p.costBasis, 'free', 'the endpoint alone says free');

  assert.equal((await roleCost(p, 'qwen3:8b')).basis, 'free');
  assert.equal((await roleCost(p, 'glm-5.3-flash:cloud')).basis, 'unpriced',
    'a model the daemon merely proxies is somebody else’s bill');
});

test('refining never downgrades a basis, and survives an endpoint that will not answer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-refine-2-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // A priced or unpriced endpoint does not become free because of its model,
  // so refining must not even ask.
  const priced = await resolveProvider({ kind: 'claude-code' }, root);
  assert.equal((await roleCost(priced, 'anything')).basis, 'priced');
  const paid = await resolveProvider(
    { kind: 'openai-compatible', id: 'o', baseUrl: 'https://openrouter.ai/api' }, root);
  assert.equal((await roleCost(paid, 'anything')).basis, 'unpriced');

  // Nothing listening: discovery returns null rather than throwing, and the
  // provider's own answer stands. Port 1 is reserved and never bound.
  const dead = await resolveProvider(
    { kind: 'openai-compatible', id: 'o', baseUrl: 'http://127.0.0.1:1' }, root);
  assert.equal((await roleCost(dead, 'whatever')).basis, 'free');
});

test('a role provider carries the role’s model, so every alias resolves on its gateway', async (t) => {
  // The run title asked for the haiku alias on a kimi worker's gateway and
  // went upstream as claude-haiku-4-5 — four 404s, no title — because the
  // per-role Ollama provider had no model of its own to pin the aliases to.
  const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-rolemodel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = await resolveProvider(
    { kind: 'openai-compatible', id: 'ollama-local', baseUrl: 'http://127.0.0.1:11434' }, root);
  assert.equal(bare.model, undefined);

  const pinned = withRoleModel(bare, 'kimi-k3:cloud');
  const { env } = providerEnv(pinned, 'http://127.0.0.1:9');
  assert.equal(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k3:cloud');
  assert.equal(env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'kimi-k3:cloud');
  assert.equal(env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kimi-k3:cloud');

  // A provider that already names a model keeps it; "inherit" changes nothing.
  assert.equal(withRoleModel({ ...bare, model: 'qwen3:8b' }, 'kimi-k3:cloud').model, 'qwen3:8b');
  assert.equal(withRoleModel(bare, '').model, undefined);
  assert.equal(withRoleModel(bare, undefined), bare, 'no change returns the same object');
});
