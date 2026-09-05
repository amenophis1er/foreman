/**
 * Providers — who serves the model, who pays for it, and where requests go.
 *
 * See docs/provider-model.md for the full design. The short version, and the
 * reason this is one module rather than three settings:
 *
 * Foreman picks credentials *ambiently*. A pinned Claude Code install
 * authenticates from its own store (a file in its config dir, or — on macOS —
 * a machine-wide Keychain item that no config dir relocates). Nothing in the
 * environment has to name a credential for one to be used.
 *
 * `ANTHROPIC_BASE_URL` is honoured whatever credential the harness ends up
 * using. Put those two facts together and redirecting the base URL at a
 * translating gateway, while an ambient login is still reachable, sends a real
 * subscription token to whatever we proxy to. That is exfiltration, not a
 * failed request.
 *
 * So provider, credential and wire are ONE choice — a discriminated union, so
 * that "subscription login" and "custom base URL" cannot both be expressed —
 * and {@link providerEnv} enforces the invariant that makes the combination
 * safe: any non-native wire ships an explicit credential that outranks
 * anything ambient. See {@link GATEWAY_INVARIANT}.
 */
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { defaultInstance } from './instance.js';
import { codexHome, isStale, readCodexAuth, refreshCodexAuth } from './codex.js';
import { getSecret } from './secrets.js';
import { discoverModels } from './models.js';
import type { ModelPrice } from './prices.js';
import type { CostBasis, ProviderRef, ClaudeInstanceRef } from './types.js';

/**
 * Anthropic's real endpoint. Set explicitly on gateway providers so a reused
 * environment (or a base URL inherited from the launching shell) can never
 * leave a native call pointed at a gateway, or the reverse.
 */
export const ANTHROPIC_NATIVE_BASE_URL = 'https://api.anthropic.com';

/**
 * Gateways bind a port the OS chooses, one process per active provider — see
 * gateway.ts. Deliberately not a fixed port: the value this was ported from is
 * 11434, which on a user's machine is Ollama's, and colliding with the thing
 * you proxy to is a poor first bug.
 */

/** How an agent's requests reach a model. */
export type Wire = 'anthropic-native' | 'gateway-openai' | 'gateway-codex';

/**
 * Credentials Claude Code would find on its own, in precedence order. A
 * gateway provider must override every one of them: leaving any unset lets an
 * ambient login win and travel to the gateway's upstream.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` and the API key vars are environment-level;
 * the config-dir store and the macOS Keychain are not, which is why the
 * override has to be a *positive* credential rather than a deletion.
 */
const AMBIENT_CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * The one rule this module exists to keep, stated so a test can name it:
 *
 *   A non-native wire MUST carry an explicit, non-empty ANTHROPIC_API_KEY and
 *   an ANTHROPIC_BASE_URL pointing at the local gateway.
 *
 * Deleting the ambient variables is not sufficient. On macOS a Claude Code
 * subscription lives in a machine-wide Keychain item that no CLAUDE_CONFIG_DIR
 * relocates, so a "clean" config dir still has a login to fall back on. An
 * explicit key outranks it — which is exactly the mechanism `own-login` exists
 * to work around, used here in the opposite direction.
 */
export const GATEWAY_INVARIANT =
  'a gateway wire must set an explicit ANTHROPIC_API_KEY and point ANTHROPIC_BASE_URL at the gateway';

/** A provider resolved against the environment and ready to dispatch. */
export interface ResolvedProvider {
  kind: ProviderRef['kind'];
  /** One line for preflight, badges and run history. Never a secret. */
  label: string;
  wire: Wire;
  /** CLAUDE_CONFIG_DIR for the agent. */
  configDir: string;
  /** Claude Code executable; the SDK's bundled one when absent. */
  executable?: string;
  /** Upstream the gateway forwards to. Absent on the native wire. */
  upstreamUrl?: string;
  /**
   * The credential to hand the agent. Present for every wire except a
   * `claude-code` provider using its own stored login, which is the one case
   * where ambient resolution is the intent.
   */
  apiKey?: string;
  /** Concrete model id, where the provider pins one. */
  model?: string;
  /**
   * Codex only: the ChatGPT account the login belongs to. The gateway reads it
   * from the token's own claims per request; this is the fallback for a token
   * that carries none.
   */
  accountId?: string;
  /**
   * `claude-code` only: strip inherited key credentials so the install's own
   * stored login pays. The original per-project billing lever.
   */
  ownLogin?: boolean;
  /**
   * What spending on this provider *is* — see {@link CostBasis}.
   *
   * The SDK prices every response with Anthropic's table. Through a gateway
   * the token counts are real but the prices are not, so a dollar cap would be
   * enforced against fiction — and it does not merely mislead, it terminates
   * working runs. Anything but `priced` caps on turns and wall-clock instead.
   */
  costBasis: CostBasis;
  /**
   * @deprecated Kept in step with {@link costBasis} for callers not yet moved
   * over. `metered === false` is `costBasis !== 'priced'`, which is exactly
   * the conflation the split exists to undo — do not branch on it.
   */
  metered: boolean;
  /** Why this provider cannot run right now, if it cannot. */
  problem?: string;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Reads the pre-provider shape. A stored `claudeInstance` (or nothing at all)
 * is a `claude-code` provider — every existing project and every run recorded
 * before this change keeps resolving to exactly what it did before.
 */
export function providerFromLegacy(legacy?: ClaudeInstanceRef | null): ProviderRef {
  return {
    kind: 'claude-code',
    configDir: legacy?.configDir,
    executable: legacy?.executable,
    ownLogin: legacy?.billing === 'own-login',
  };
}

/** The provider a stored record uses, tolerating records written before providers existed. */
export function providerOf(
  record: { provider?: ProviderRef; claudeInstance?: ClaudeInstanceRef },
): ProviderRef {
  return record.provider ?? providerFromLegacy(record.claudeInstance);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Expands a leading `~` so config can be written the way people type it. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? expandHome(trimmed) : undefined;
}

/**
 * Config dir Foreman creates and owns for a provider that must NOT see an
 * Anthropic login. Kept under the data root rather than beside the user's own
 * installs, so it is obvious who put it there and safe to delete.
 */
export function ownedConfigDir(root: string, id: string): string {
  return path.join(root, 'instances', id.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/**
 * Resolves a provider reference against the environment.
 *
 * Never throws and never returns a partially-usable provider: anything that
 * would prevent a run is reported in `problem`, so preflight and the composer
 * can say what is wrong before a mission starts rather than three tool calls
 * in.
 *
 * @param root Foreman's data root, for Foreman-owned config dirs.
 */
export async function resolveProvider(ref: ProviderRef, root: string): Promise<ResolvedProvider> {
  switch (ref.kind) {
    case 'claude-code': {
      // Project override wins field by field over the server default, so a
      // project can pin a config dir while inheriting the executable.
      const base = defaultInstance();
      const configDir =
        clean(ref.configDir) ?? base.configDir ?? clean(process.env.CLAUDE_CONFIG_DIR)
        ?? path.join(os.homedir(), '.claude');
      return {
        kind: ref.kind,
        wire: 'anthropic-native',
        ...basis('priced'),
        label: `Claude Code · ${configDir}${ref.ownLogin ? ' (its own login pays)' : ''}`,
        configDir,
        executable: clean(ref.executable) ?? base.executable,
        ownLogin: ref.ownLogin,
      };
    }

    case 'anthropic-api': {
      const apiKey = await providerKey(root, ref.id, ref.apiKeyEnv);
      return {
        kind: ref.kind,
        wire: 'anthropic-native',
        ...basis('priced'),
        label: `Anthropic API key · $${ref.apiKeyEnv}`,
        // Foreman-owned: an API-key provider has no business reading a user
        // install's settings, plugins or login.
        configDir: ownedConfigDir(root, ref.id),
        apiKey,
        model: ref.model,
        problem: apiKey ? undefined : missingKey(ref.apiKeyEnv),
      };
    }

    case 'codex': {
      const home = codexHome(ref.codexHome);
      // Refresh here rather than at dispatch: a token that expires mid-mission
      // fails every remaining turn, and the rotated refresh token is
      // single-use, so the write has to happen where it can be persisted.
      let auth = await readCodexAuth(home);
      if (auth && isStale(auth)) auth = (await refreshCodexAuth(home, auth)) ?? auth;
      const token = auth?.OPENAI_API_KEY || auth?.tokens?.access_token;
      const problem = auth
        ? (token ? undefined : `${home}/auth.json holds no usable credential — run \`codex login\``)
        : `no Codex login at ${home}/auth.json — run \`codex login\``;
      return {
        kind: ref.kind,
        wire: 'gateway-codex',
        ...basis('unpriced'),
        label: `Codex · ${home}`,
        configDir: ownedConfigDir(root, ref.id),
        upstreamUrl: ref.upstreamUrl ?? 'https://chatgpt.com/backend-api',
        apiKey: token,
        accountId: auth?.tokens?.account_id,
        model: ref.model,
        problem,
      };
    }

    case 'openai-compatible': {
      // A local Ollama needs no credential at all; the gateway still requires
      // a non-empty key downstream (see GATEWAY_INVARIANT), so a placeholder
      // stands in. It is never sent as a real secret — the upstream ignores it.
      const key = ref.apiKeyEnv || ref.needsKey
        ? await providerKey(root, ref.id, ref.apiKeyEnv)
        : 'no-key-required';
      return {
        kind: ref.kind,
        wire: 'gateway-openai',
        // An endpoint on this machine is the operator's own hardware and
        // costs nothing per token. Anything reachable only over the network
        // is somebody's paid service — unpriced until a price source says
        // otherwise, never free by default, because guessing "free" about a
        // billed endpoint is the error that costs money.
        ...basis(isPrivateHost(hostOf(ref.baseUrl)) ? 'free' : 'unpriced'),
        label: `${ref.label ?? 'OpenAI-compatible'} · ${ref.baseUrl}`,
        configDir: ownedConfigDir(root, ref.id),
        upstreamUrl: normalizeOpenAiBaseUrl(ref.baseUrl),
        apiKey: key,
        model: ref.model,
        problem: key ? undefined : missingKey(ref.apiKeyEnv),
      };
    }
  }
}

/**
 * A provider's credential: the key stored for it, else the named environment
 * variable.
 *
 * Stored wins because it is the deliberate choice — someone pasted it into
 * Settings for this provider. An env var is the escape hatch for a server
 * started with one already exported, and for anyone who would rather Foreman
 * held nothing.
 */
async function providerKey(
  root: string, id: string, apiKeyEnv?: string,
): Promise<string | undefined> {
  const stored = await getSecret(root, id).catch(() => null);
  if (stored) return stored;
  return apiKeyEnv ? clean(process.env[apiKeyEnv]) : undefined;
}

/** Says what to do about a missing key without naming a value. */
function missingKey(apiKeyEnv?: string): string {
  return apiKeyEnv
    ? `no key stored for this provider, and $${apiKeyEnv} is not set in the server environment`
    : 'this endpoint needs a key — add one in Settings';
}

/**
 * Normalises a user-supplied OpenAI-compatible base URL to the host root the
 * gateway appends `/v1/...` to. Tolerates a pasted `/v1` suffix, trailing
 * slashes, and a scheme-less paste (which would otherwise throw inside the
 * gateway's `new URL()` and take the agent down on its first call).
 */
export function normalizeOpenAiBaseUrl(url: string): string {
  let base = url.trim();
  if (!/^https?:\/\//i.test(base)) {
    // Scheme-less is how people type a local daemon — `127.0.0.1:11434`, or a
    // hostname on a private network. Defaulting those to https guarantees a
    // handshake failure on the first call, so infer from the host: public
    // names get https, anything that cannot plausibly hold a certificate does
    // not. An explicit scheme is always honoured.
    base = `${isPrivateHost(base.split('/')[0]) ? 'http' : 'https'}://${base}`;
  }
  return base.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** What one agent role's spend is, and what it costs when that is knowable. */
export interface RoleCost {
  basis: CostBasis;
  /**
   * Per-token rates for the chosen model, when the endpoint publishes them.
   *
   * Present only where `basis` is `priced` *because of the endpoint* — an
   * Anthropic-native role is also priced but carries no rates here, because
   * the SDK already reports its real cost and Foreman should not second-guess
   * it with a table.
   */
  price?: ModelPrice;
}

/**
 * What a role actually costs: its basis, sharpened by the model it will run.
 *
 * Two facts come out of one lookup, because they come from one place.
 *
 *  - **The model can raise the endpoint's floor.** An Ollama daemon on this
 *    machine is free, but the same daemon serves `:cloud` models that run on
 *    paid servers and signs for them with the operator's own account. Loopback
 *    is not proof a run is free, and that is the configuration Foreman is most
 *    often used in.
 *  - **The model can also carry a price.** Where the endpoint publishes
 *    per-token rates (OpenRouter does, for essentially everything it serves),
 *    the run becomes genuinely `priced` — with the bill-sender's own numbers,
 *    not a table shipped inside Foreman.
 *
 * Discovery never throws: when it cannot answer, the provider's own basis
 * stands with no price, which is the answer we had before asking.
 */
export async function roleCost(p: ResolvedProvider, model?: string): Promise<RoleCost> {
  // An Anthropic-native role is already priced by the SDK, with real rates for
  // real tokens. Nothing an endpoint listing says could improve on that.
  if (p.wire === 'anthropic-native' || !p.upstreamUrl) return { basis: p.costBasis };
  const chosen = model || p.model;
  if (!chosen) return { basis: p.costBasis };

  const found = await discoverModels(p.upstreamUrl, { apiKey: p.apiKey });
  const m = found?.find((x) => x.id === chosen);
  if (!m) return { basis: p.costBasis };
  if (m.price) return { basis: 'priced', price: m.price };
  // No published rates: real spend we cannot quantify, unless the endpoint is
  // the operator's own hardware AND the model actually runs there.
  return { basis: p.costBasis === 'free' && !m.remote ? 'free' : 'unpriced' };
}

/** The host[:port] of a base URL, however sloppily it was typed. */
function hostOf(url: string): string {
  const bare = url.trim().replace(/^https?:\/\//i, '');
  return bare.split('/')[0] ?? '';
}

/**
 * A cost basis and the deprecated boolean that shadows it, written together.
 *
 * They are set in one place so they cannot drift: a resolver that set one and
 * forgot the other would leave a provider whose enforcement and whose display
 * disagree, which is the failure this whole split exists to remove.
 */
function basis(costBasis: CostBasis): { costBasis: CostBasis; metered: boolean } {
  return { costBasis, metered: costBasis === 'priced' };
}

/** Loopback, a private range, or a LAN name — somewhere https is unlikely. */
function isPrivateHost(hostPort: string): boolean {
  const host = hostPort.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // A bare single-label name (`box:11434`) is a LAN host, not a public domain.
  return /^[a-z0-9-]+$/.test(host);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface AgentEnv {
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
}

/**
 * The `query()` options fragment for a provider — the single place that
 * decides what credential an agent can reach.
 *
 * `env` replaces the child's environment rather than extending it, so
 * process.env is spread first: dropping it would strip PATH and HOME along
 * with the credentials.
 *
 * @throws if the result would violate {@link GATEWAY_INVARIANT}. That is a
 * programming error rather than a user error, and the failure mode it guards
 * against is a leaked token, so it fails loudly instead of degrading.
 */
export function providerEnv(p: ResolvedProvider, gatewayUrl?: string): AgentEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  env.CLAUDE_CONFIG_DIR = p.configDir;

  if (p.wire === 'anthropic-native') {
    if (p.kind === 'claude-code') {
      // The one intentionally ambient case: the install's own stored login is
      // the credential. `ownLogin` strips an inherited key that would outrank
      // it — the original per-project billing behaviour, unchanged.
      if (p.ownLogin) for (const v of AMBIENT_CREDENTIAL_VARS) delete env[v];
    } else {
      // An explicit Anthropic key: set it, and clear the OAuth token so a
      // machine-wide subscription cannot win instead and bill the wrong party.
      env.ANTHROPIC_API_KEY = p.apiKey;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      env.ANTHROPIC_BASE_URL = ANTHROPIC_NATIVE_BASE_URL;
    }
  } else {
    // Gateway wires. Every ambient credential is displaced by an explicit one
    // — see GATEWAY_INVARIANT for why deleting them is not enough.
    for (const v of AMBIENT_CREDENTIAL_VARS) delete env[v];
    env.ANTHROPIC_API_KEY = p.apiKey;
    env.ANTHROPIC_BASE_URL = gatewayUrl;

    // Model aliases. Foreman's cost model IS these aliases — director opus,
    // workers sonnet, run titles haiku — and on a gateway wire the SDK would
    // otherwise resolve them to claude-* ids the upstream rejects, failing
    // every worker.
    if (p.model) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = p.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = p.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = p.model;
      env.LLM_GATEWAY_DEFAULT_MODEL = p.model;
    }

    if (!env.ANTHROPIC_API_KEY || !gatewayUrl) {
      throw new Error(`${GATEWAY_INVARIANT} (provider: ${p.kind})`);
    }
  }

  const out: AgentEnv = { env };
  if (p.executable) out.pathToClaudeCodeExecutable = p.executable;
  return out;
}

/**
 * Whether a resolved provider can actually run a mission right now. Returns
 * the reason it cannot, or null.
 */
export function providerProblem(p: ResolvedProvider): string | null {
  if (p.problem) return p.problem;
  if (p.wire !== 'anthropic-native' && !p.apiKey) return GATEWAY_INVARIANT;
  return null;
}
