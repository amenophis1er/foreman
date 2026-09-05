/**
 * What models does an endpoint actually have?
 *
 * Every `openai-compatible` provider can answer this, and the answer belongs
 * to the *endpoint*, not to the server: a project pointed at an Ollama on
 * another machine must be offered that machine's models, not this one's.
 *
 * Two probes, richest first:
 *
 *  - `GET /api/tags` — Ollama's own. Worth preferring where it answers,
 *    because it distinguishes a local model from a `:cloud` one and reports
 *    parameter counts, and those are the facts a person actually chooses on.
 *  - `GET /v1/models` — the OpenAI-compatible standard. Works for ollama.com
 *    direct, OpenRouter, vLLM, LM Studio, and anything else in that family,
 *    but returns bare ids.
 *
 * Neither throws. A picker that cannot reach its endpoint shows an empty list
 * and says so; it does not fail a page.
 */
import { parsePricing, type ModelPrice } from './prices.js';

export interface EndpointModel {
  /** Exactly what the API expects as a model id. */
  id: string;
  /** Parameter count where the endpoint reports one. */
  size?: string;
  /** Runs somewhere other than the endpoint's own machine (Ollama `:cloud`). */
  remote: boolean;
  /** Where a remote model actually runs, e.g. `https://ollama.com`. */
  host?: string;
  /**
   * Per-token rates, where the endpoint publishes them (OpenRouter does).
   *
   * This is the only price Foreman will ever put a dollar sign on for a
   * gateway run: it comes from the party that sends the bill. Absent means
   * unpriced, and unpriced is left saying so — see prices.ts.
   */
  price?: ModelPrice;
}

export interface DiscoverOptions {
  /** Bearer credential, for endpoints that need one to list models. */
  apiKey?: string;
  /** Discovery runs on page loads and preflight; it must not hang either. */
  timeoutMs?: number;
}

async function getJson(url: string, apiKey?: string, timeoutMs = 1500): Promise<unknown | null> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

/** Ollama's `/api/tags`, which knows more than the OpenAI shape can express. */
function fromOllamaTags(body: unknown): EndpointModel[] | null {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return null;
  const out: EndpointModel[] = [];
  for (const m of models as Array<Record<string, any>>) {
    if (typeof m?.name !== 'string' || !m.name) continue;
    out.push({
      id: m.name,
      size: m.details?.parameter_size || undefined,
      remote: Boolean(m.remote_model),
      host: m.remote_host || undefined,
    });
  }
  return out;
}

/**
 * The OpenAI-compatible `/v1/models` listing: ids, and rates where the
 * endpoint volunteers them. OpenAI's own listing carries none; OpenRouter's
 * carries a full `pricing` object per model.
 */
function fromOpenAiList(body: unknown): EndpointModel[] | null {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const out: EndpointModel[] = [];
  for (const m of data as Array<Record<string, any>>) {
    if (typeof m?.id !== 'string' || !m.id) continue;
    const price = parsePricing(m.pricing);
    out.push({ id: m.id, remote: false, ...(price ? { price } : {}) });
  }
  return out;
}

/**
 * Models an OpenAI-compatible endpoint offers, or null if it cannot be
 * reached. `baseUrl` is the host root — the same value a provider stores.
 */
export async function discoverModels(
  baseUrl: string,
  { apiKey, timeoutMs = 1500 }: DiscoverOptions = {},
): Promise<EndpointModel[] | null> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

  const tags = fromOllamaTags(await getJson(`${root}/api/tags`, apiKey, timeoutMs));
  // An Ollama with nothing pulled answers with an empty list, which is a real
  // answer — fall through to /v1/models only when the probe did not apply.
  const models = tags ?? fromOpenAiList(await getJson(`${root}/v1/models`, apiKey, timeoutMs));
  if (!models) return null;

  // Plain alphabetical. A cloud model is not a lesser option to be listed after
  // the real ones — it is the one fast enough to direct a mission with.
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Per-million-token rates, which is how a pricing page reads.
 *
 * The conversion lives here, in the one place that renders a rate for a
 * person — prices.ts deliberately keeps the source's own per-token unit so
 * there is exactly one factor of a million to get wrong.
 */
function rateLine(price: ModelPrice): string {
  const perM = (n: number) => {
    const v = n * 1_000_000;
    // Sub-cent rates are real and common; rounding them to "$0.00" would say
    // free about something that is not.
    return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
  };
  if (price.input === 0 && price.output === 0) return 'Free at this endpoint.';
  return `${perM(price.input)} in / ${perM(price.output)} out per million tokens.`;
}

/**
 * The picker's 0–4 cost bars, from a real rate where there is one.
 *
 * A rank, not a figure — the line under it carries the actual number. Banded
 * on the output rate because output dominates what an agent run spends, and a
 * constant guess (every remote model was "2") ranked a cheap flash model
 * level with a flagship.
 */
export function costRank(m: EndpointModel): 0 | 1 | 2 | 3 | 4 {
  if (!m.price) return m.remote ? 2 : 0;
  const perM = m.price.output * 1_000_000;
  if (perM === 0) return 0;
  if (perM < 1) return 1;
  if (perM < 5) return 2;
  if (perM < 20) return 3;
  return 4;
}

/** One line for a picker, naming the trade rather than ranking the options. */
export function describeModel(m: EndpointModel): string {
  // A published rate is the most useful thing anyone can be told about a
  // model they are about to spend on, so it leads.
  if (m.price) return rateLine(m.price);
  if (m.remote) {
    return `Runs on ${m.host ?? 'the provider’s servers'}, not this machine. ` +
      'Fast; billed to that account, at a rate Foreman cannot see.';
  }
  return `Local${m.size ? ` · ${m.size}` : ''}. Free and private, but slow on long prompts.`;
}
