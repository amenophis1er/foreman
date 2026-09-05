/**
 * What a token actually costs, from the endpoint that will actually bill it.
 *
 * The obvious way to price a gateway run is a table of vendor rates shipped
 * inside Foreman. This deliberately is not that. A table written from memory
 * is a fabricated number wearing a dollar sign, and the whole reason the cost
 * basis exists is that Foreman had been showing exactly that — Anthropic's
 * rates applied to somebody else's tokens — and once killed a working mission
 * over it.
 *
 * So prices come from the endpoint. OpenRouter publishes per-token rates for
 * every model on `/v1/models`, including separate cache-read and cache-write
 * rates, and it is the party that sends the bill — there is no more
 * authoritative source, and nothing to keep in sync. An endpoint that
 * publishes nothing stays `unpriced`, which is a true statement about what
 * Foreman knows. It is not a gap to be filled in with a guess.
 */

/**
 * Rates in USD per token — the unit the source publishes, kept as-is.
 *
 * Per *million* tokens is how humans read pricing pages, and converting here
 * would mean two places to get a factor of a million wrong. The conversion
 * belongs in whatever renders it, once.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Publishing these separately is common; absent means "same as input". */
  cacheRead?: number;
  cacheWrite?: number;
}

/** Token counts, as the orchestrator accumulates them. */
interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const num = (v: unknown): number | null => {
  // Rates arrive as strings ("0.00001"), which is how a source avoids float
  // formatting; anything that does not parse is treated as unpublished rather
  // than as zero, because a zero rate silently prices a paid model at nothing.
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * An OpenRouter-style `pricing` object, or null if it does not carry usable
 * per-token rates.
 *
 * Both input and output must be present. A half-published price would produce
 * a figure that is confidently too low, which is worse than showing none —
 * "unpriced" sends someone to their vendor dashboard, a wrong number does not.
 */
export function parsePricing(raw: unknown): ModelPrice | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const input = num(p.prompt);
  const output = num(p.completion);
  if (input === null || output === null) return null;
  // A genuinely free model publishes 0/0; that is a real answer and priced at
  // zero is exactly right for it.
  const price: ModelPrice = { input, output };
  const cacheRead = num(p.input_cache_read);
  const cacheWrite = num(p.input_cache_write);
  if (cacheRead !== null) price.cacheRead = cacheRead;
  if (cacheWrite !== null) price.cacheWrite = cacheWrite;
  return price;
}

/**
 * What a batch of tokens costs, cache-aware.
 *
 * Cached reads and writes are billed at their own rates where the endpoint
 * publishes them, and at the input rate where it does not. That fallback
 * overstates a cache read (which is normally the cheapest token there is) and
 * understates a cache write — but only for endpoints that declined to say, and
 * both errors are bounded by the input rate rather than unbounded.
 */
export function priceUsage(price: ModelPrice, usage: Usage): number {
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * (price.cacheRead ?? price.input) +
    usage.cacheWriteTokens * (price.cacheWrite ?? price.input)
  );
}
