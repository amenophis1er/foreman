/**
 * What stopped the run, said in one sentence.
 *
 * A provider's refusal arrives as a wall of JSON — status codes, plan names,
 * epoch seconds. The strip above a stopped run needs the one thing the human
 * decides on: what happened and, when the provider says so, when it will
 * stop happening. Unknown shapes fall back to their first line, clipped.
 */

export interface StopReason {
  /** One sentence, no JSON. */
  text: string;
  /** Epoch ms when the provider says the limit lifts, when it says. */
  resetsAt?: number;
  /** The class of failure, for callers that want to choose a hint. */
  kind: 'usage-limit' | 'rate-limit' | 'auth' | 'server' | 'other';
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

function firstJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  for (let end = raw.lastIndexOf('}'); end > start; end = raw.lastIndexOf('}', end - 1)) {
    try { const v = JSON.parse(raw.slice(start, end + 1)); if (v && typeof v === 'object') return v as Record<string, unknown>; } catch { /* keep shrinking */ }
  }
  return null;
}

/** `resets_at` as epoch seconds, `resets_in_seconds`, or `retry_after` — whichever the payload carries. */
function resetFrom(err: Record<string, unknown>, now: number): number | undefined {
  const at = Number(err.resets_at);
  if (Number.isFinite(at) && at > 1e9) return at < 1e12 ? at * 1000 : at;
  const inS = Number(err.resets_in_seconds ?? err.retry_after);
  if (Number.isFinite(inS) && inS > 0) return now + inS * 1000;
  return undefined;
}

function provider(raw: string): string {
  if (/codex/i.test(raw)) return 'Codex';
  if (/anthropic|claude/i.test(raw)) return 'Anthropic';
  if (/ollama/i.test(raw)) return 'Ollama';
  if (/openrouter/i.test(raw)) return 'OpenRouter';
  if (/openai/i.test(raw)) return 'OpenAI';
  return 'The provider';
}

export function describeStop(raw: string | undefined, now = Date.now()): StopReason | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const json = firstJson(text);
  const err = (json && typeof json.error === 'object' && json.error ? json.error : json) as Record<string, unknown> | null;
  const type = String(err?.type ?? err?.code ?? '');
  const message = String(err?.message ?? '');
  const who = provider(text);
  const resetsAt = err ? resetFrom(err, now) : undefined;
  const when = resetsAt ? ` — resets ${fmtReset(resetsAt, now)}` : '';

  if (/usage_limit|usage limit|quota/i.test(type + ' ' + message)) {
    return { kind: 'usage-limit', resetsAt, text: `${who} usage limit reached${err?.plan_type ? ` on the ${err.plan_type} plan` : ''}${when}.` };
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) {
    return { kind: 'rate-limit', resetsAt, text: `${who} rate limit hit${when}.` };
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.*(key|token)|authentication/i.test(text)) {
    return { kind: 'auth', text: `${who} refused the credentials — log in again, or check the key.` };
  }
  if (/\b5\d\d\b|overloaded|unavailable|ECONNREFUSED|ENOTFOUND|timeout/i.test(text)) {
    return { kind: 'server', text: `${who} could not be reached or answered with a server error.` };
  }
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  return { kind: 'other', text: clip(line.replace(/^API Error:\s*/i, ''), 160) };
}

/** `at 06:53 (in 4h 42m)` — absolute for the plan, relative for the feel. */
export function fmtReset(resetsAt: number, now = Date.now()): string {
  const at = new Date(resetsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const mins = Math.max(0, Math.round((resetsAt - now) / 60_000));
  const rel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return `at ${at} (in ${rel})`;
}
