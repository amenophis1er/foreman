/**
 * The Anthropic model list — the one catalogue Foreman cannot ask for.
 *
 * **Edit this file when Anthropic ships or retires a model.** It is the only
 * hardcoded model list in the product, and it is deliberately in a file of its
 * own so it is obvious where to look.
 *
 * Every other provider is queried live: Ollama answers `/api/tags`, an
 * OpenAI-compatible endpoint answers `/v1/models`, and Codex keeps its own
 * `models_cache.json` that the CLI maintains. Anthropic has an API for this
 * too — `GET /v1/models` — but it needs an API key, and Foreman's common case
 * is a Claude Code *subscription*, which has no key to send. So this list is
 * the fallback for the case nothing can be queried.
 *
 * What actually reaches the SDK is the `id` — the alias. Aliases keep
 * resolving as Anthropic updates the models behind them, so a stale `model`
 * string here misleads the eye without breaking a run. That is the reason this
 * list drifting is survivable, not a reason to leave it wrong.
 *
 * `cost` is a 1–4 relative rank for the picker's bars, not a price.
 */
export interface CatalogModel {
  /** Sent to the SDK as `options.model`. An alias, so it survives model updates. */
  id: string;
  label: string;
  /** The concrete model behind the alias, shown in mono. Display only. */
  model: string;
  cost: 1 | 2 | 3 | 4;
  note: string;
}

export const ANTHROPIC_MODELS: CatalogModel[] = [
  {
    id: 'fable', label: 'Fable', model: 'claude-fable-5-1', cost: 4,
    note: 'Frontier. Long-horizon planning and verification.',
  },
  {
    id: 'opus', label: 'Opus', model: 'claude-opus-5', cost: 3,
    note: 'Deep reasoning for hard refactors.',
  },
  {
    id: 'sonnet', label: 'Sonnet', model: 'claude-sonnet-5', cost: 2,
    note: 'Balanced. The usual worker.',
  },
  {
    id: 'haiku', label: 'Haiku', model: 'claude-haiku-4-5', cost: 1,
    note: 'Fast and cheap for reads and mechanical edits.',
  },
];

/** Aliases, for the places that need to know a choice is an Anthropic one. */
export const ANTHROPIC_ALIASES: ReadonlySet<string> = new Set(
  ANTHROPIC_MODELS.map((m) => m.id),
);
