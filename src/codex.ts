/**
 * Codex credentials — read what `codex login` already wrote, refresh it when
 * stale, never mint one ourselves.
 *
 * The standing rule (provider-model.md §5): Foreman is on the machine where
 * `codex login` already ran, so it reads `~/.codex/auth.json` the way
 * `provider.ts` reads a Claude Code install's own store. It does not
 * reimplement OpenAI's OAuth flow, does not open a browser, and does not walk
 * a device-code dance — the only network call this module makes is a
 * refresh-token grant against a token that is already on disk.
 *
 * `auth.json` is Codex's file, not ours. A refresh rotates `refresh_token`
 * (single-use — the old one stops working the instant a new one is issued),
 * so the write-back must replace only the `tokens` field and leave everything
 * else — `auth_mode`, `OPENAI_API_KEY`, whatever future field Codex adds —
 * exactly as Codex left it. Losing an unrecognised field here would silently
 * corrupt the CLI's own login the next time it runs.
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';

/** Matches the shape `codex login` writes to `auth.json`. */
export interface CodexAuth {
  auth_mode: string;
  OPENAI_API_KEY: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  /** Anything else Codex ever adds. Preserved verbatim on write-back. */
  [key: string]: unknown;
}

/** One entry from `models_cache.json` — Codex's own catalogue, not ours. */
interface CodexModelsCache {
  fetched_at?: string;
  etag?: string;
  client_version?: string;
  models?: Array<{ slug?: string; [key: string]: unknown }>;
}

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Default staleness window: refresh proactively rather than on first 401. */
const DEFAULT_MAX_AGE_MS = 25 * 60 * 1000;

/** The Codex CLI's home: `CODEX_HOME`, then `~/.codex`. */
export function codexHome(override?: string): string {
  const raw = (override ?? process.env.CODEX_HOME ?? '').trim();
  return raw ? raw : path.join(os.homedir(), '.codex');
}

/**
 * Reads and parses `auth.json`. Null covers every ordinary "not usable" case
 * — no install, no login, a file mid-write, a shape we don't recognise — on
 * purpose: a missing Codex install is a fact about the machine, not an error
 * to surface with a stack trace. Never includes file contents in what it
 * throws or logs, since that file holds live tokens.
 */
export async function readCodexAuth(home: string): Promise<CodexAuth | null> {
  const file = path.join(home, 'auth.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const auth = parsed as CodexAuth;
  // Usable means: something we can actually authenticate a request with.
  if (!auth.OPENAI_API_KEY && !auth.tokens?.access_token) return null;
  return auth;
}

/** Whether `auth.json`'s `last_refresh` is old enough to refresh proactively. */
export function isStale(auth: CodexAuth, maxAgeMs = DEFAULT_MAX_AGE_MS): boolean {
  const last = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;
  if (Number.isNaN(last)) return true; // no timestamp we trust — treat as stale
  return Date.now() - last >= maxAgeMs;
}

type FetchLike = typeof fetch;

/**
 * Refreshes an OAuth-mode login and persists the rotated refresh token.
 *
 * Returns null on any failure — no network, no refresh token to send, a
 * non-2xx response, an unparsable body — rather than throwing, matching every
 * other function here: a refresh failure means "fall back to what's on disk
 * (or fail preflight)", not a crash.
 *
 * The write-back is tmp-file + rename (atomic on the same filesystem, which a
 * sibling temp file always is) and starts from the file's *current* on-disk
 * content re-read fresh, not the `auth` passed in — so a field Codex itself
 * changed between our read and our refresh isn't clobbered by a stale copy.
 * Only `tokens` and `last_refresh` are touched.
 */
export async function refreshCodexAuth(
  home: string,
  auth: CodexAuth,
  fetchImpl: FetchLike = fetch,
): Promise<CodexAuth | null> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) return null;

  let body: { access_token?: string; id_token?: string; refresh_token?: string };
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    body = (await res.json()) as typeof body;
  } catch {
    return null;
  }
  if (!body.access_token) return null;

  const file = path.join(home, 'auth.json');
  // Re-read the file on disk rather than trusting the caller's copy: this is
  // the only place we write, so it's the only place that can silently drop a
  // field Codex wrote in the meantime.
  const current = (await readCodexAuth(home)) ?? auth;
  const updated: CodexAuth = {
    ...current,
    tokens: {
      ...current.tokens,
      access_token: body.access_token,
      id_token: body.id_token ?? current.tokens?.id_token,
      // The refresh token Codex returns is single-use; if the response omits
      // one (shouldn't happen, but the API is someone else's), keep the old
      // one rather than nulling out the only credential we could refresh with
      // next time.
      refresh_token: body.refresh_token ?? current.tokens?.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };

  const tmp = path.join(home, `.auth.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(updated, null, 2));
    await rename(tmp, file);
  } catch {
    return null;
  }
  return updated;
}

/**
 * Model ids from `models_cache.json` — Codex's own list, so the picker never
 * drifts from what the install actually has. Empty array (never a throw) if
 * the file is absent, unparsable, or shaped differently than expected: an
 * empty picker is an ordinary state, a crashed preflight is not.
 */
export async function codexModels(home: string): Promise<string[]> {
  const file = path.join(home, 'models_cache.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as CodexModelsCache;
    const models = parsed.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m) => m.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
  } catch {
    return [];
  }
}
