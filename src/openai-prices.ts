/**
 * OpenAI list prices — the one table Foreman keeps, by decision.
 *
 * The provider model's rule is that a dollar figure comes from whoever sends
 * the bill. OpenAI's API publishes no rates, and the human wants direct
 * OpenAI rather than a reseller that does, so this table exists — under the
 * one condition that makes it honest: **provenance made visible.** It names
 * its source, it names the day it was checked, and it is the only place in
 * the codebase where a price is written down by a person. A model not in it
 * stays `unpriced`; a wrong entry is a bug with a date on it, not a guess.
 *
 * SOURCE   https://developers.openai.com/api/docs/pricing  (Standard tier)
 * VERIFIED 2026-09-05
 * UNIT     the page lists USD per 1M tokens; stored here per token, the unit
 *          `ModelPrice` uses, so the factor of a million lives in exactly one
 *          line (`perM`) and nowhere else.
 *
 * KNOWN GAPS, on purpose:
 *  - Long-context tiers. gpt-5.5, gpt-5.4 and their pro variants charge more
 *    past 272K input tokens; this table holds the base tier. A run that
 *    routinely exceeds that will read low — the direction that is not safe —
 *    so the description says so.
 *  - Batch and Flex tiers are cheaper and not represented. Foreman does not
 *    use them.
 *  - Dated snapshots (`gpt-5.4-2026-03-01`) resolve to their family by
 *    longest-prefix match. A new family not listed here is unpriced until
 *    someone updates this file and the VERIFIED line with it.
 *
 * To update: open the source URL, change the numbers, change VERIFIED. That
 * is the whole procedure, and the reason it lives in its own small file.
 */
import type { ModelPrice } from './prices.js';

/** USD per 1M tokens → USD per token. The only conversion in this file. */
const perM = (usdPerMillion: number): number => usdPerMillion / 1_000_000;

interface Row { input: number; cachedInput?: number; output: number }

/** Standard tier, USD per 1M tokens, exactly as listed on VERIFIED date. */
const LIST: Record<string, Row> = {
  'gpt-6-astra':   { input: 10.00, cachedInput: 1.00,  output: 50.00 },
  'gpt-5.6-sol':   { input: 4.00,  cachedInput: 0.40,  output: 20.00 },
  'gpt-5.6-terra': { input: 2.00,  cachedInput: 0.20,  output: 12.00 },
  'gpt-5.6-luna':  { input: 0.20,  cachedInput: 0.02,  output: 1.20 },
  'gpt-5.5':       { input: 5.00,  cachedInput: 0.50,  output: 30.00 },   // <272K
  'gpt-5.5-pro':   { input: 30.00,                     output: 180.00 },  // <272K
  'gpt-5.4':       { input: 2.50,  cachedInput: 0.25,  output: 15.00 },   // <272K
  'gpt-5.4-mini':  { input: 0.75,  cachedInput: 0.075, output: 4.50 },
  'gpt-5.4-nano':  { input: 0.20,  cachedInput: 0.02,  output: 1.25 },
  'gpt-5.4-pro':   { input: 30.00,                     output: 180.00 },  // <272K
  'gpt-5.2':       { input: 1.75,  cachedInput: 0.175, output: 14.00 },
  'gpt-5.2-pro':   { input: 21.00,                     output: 168.00 },
  'gpt-5.1':       { input: 1.25,  cachedInput: 0.125, output: 10.00 },
  'gpt-5':         { input: 1.25,  cachedInput: 0.125, output: 10.00 },
  'gpt-5-mini':    { input: 0.25,  cachedInput: 0.025, output: 2.00 },
  'gpt-5-nano':    { input: 0.05,  cachedInput: 0.005, output: 0.40 },
  'gpt-5-pro':     { input: 15.00,                     output: 120.00 },
  'o1':            { input: 15.00, cachedInput: 7.50,  output: 60.00 },
  'o1-pro':        { input: 150.00,                    output: 600.00 },
  'o3-pro':        { input: 20.00,                     output: 80.00 },
  'o3':            { input: 2.00,  cachedInput: 0.50,  output: 8.00 },
  'o4-mini':       { input: 1.10,  cachedInput: 0.275, output: 4.40 },
  'o3-mini':       { input: 1.10,  cachedInput: 0.55,  output: 4.40 },
};

export const OPENAI_PRICES_VERIFIED = '2026-09-05';
export const OPENAI_PRICES_SOURCE = 'https://developers.openai.com/api/docs/pricing';

/** Hosts whose models this table prices. Nothing else — a reseller sets its own rates. */
export function isOpenAiHost(upstreamUrl: string | undefined): boolean {
  try { return !!upstreamUrl && /(^|\.)api\.openai\.com$/i.test(new URL(upstreamUrl).hostname); }
  catch { return false; }
}

/**
 * The list price for a model id, or null if the table does not know it.
 *
 * Exact id first; otherwise the longest family key the id starts with
 * followed by a dash (so `gpt-5.4-2026-03-01` is `gpt-5.4`, and `gpt-5.4-mini`
 * is not mistaken for `gpt-5.4`). Cached-input goes into `cacheRead`; OpenAI
 * has no cache-write charge, so `cacheWrite` is the input rate — which
 * `priceUsage` uses as the default when the field is absent.
 */
export function openaiPrice(modelId: string | undefined): ModelPrice | null {
  if (!modelId) return null;
  const id = modelId.trim().toLowerCase();
  let key: string | undefined = LIST[id] ? id : undefined;
  if (!key) {
    key = Object.keys(LIST)
      .filter((k) => id.startsWith(`${k}-`))
      .sort((a, b) => b.length - a.length)[0];
  }
  if (!key) return null;
  const r = LIST[key];
  const price: ModelPrice = { input: perM(r.input), output: perM(r.output) };
  if (r.cachedInput !== undefined) price.cacheRead = perM(r.cachedInput);
  return price;
}

/** For the picker's note: "$2.50 in / $15.00 out per million tokens · OpenAI list, verified 2026-09-05". */
export function openaiPriceNote(modelId: string): string | null {
  const p = openaiPrice(modelId);
  if (!p) return null;
  const m = (n: number) => `$${(n * 1_000_000).toFixed(2)}`;
  return `${m(p.input)} in / ${m(p.output)} out per million tokens · OpenAI list price, verified ${OPENAI_PRICES_VERIFIED}`;
}
