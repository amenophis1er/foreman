Picks the model for a role. Appears twice in the composer — Director and Workers — and nowhere else.

```jsx
const { models, loading } = ModelSelect.useModels('/models'); // once, in the screen
<ModelSelect value={directorModel} onChange={(id, m) => setDirectorModel(id)} models={models} loading={loading} />
```

- The list is server-provided (`GET /models` → `{models:[{id,label,model,providerId?,providerLabel,cost,note,costBasis}], groups:[...]}`), never hard-coded in a screen. `FALLBACK_MODELS` covers the gap before the endpoint answers — a flat, single-provider (Anthropic) list.
- Trigger: cpu icon · label · chevron, 150px min. While loading it reads "Fetching models…" and is disabled. When the current selection is a non-Anthropic provider, a muted tag naming it (`Ollama`, `Codex`, a custom label) sits right after the label — a chosen local model must not look identical to a chosen Anthropic one at a glance, which is the entire reason this build exists.
- Menu rows: check (selected, gold) · label + exact model id in mono · one-line note · four-bar cost mark. "Default" is always the first row, outside any group, and means inherit.
- **Grouped by provider.** Rows are bucketed by `providerLabel` (absent = `'Anthropic'`), in the order providers first appear in `models` — the server always puts Anthropic first, so no client-side sort is needed. A group heading (name + count, sticky within the scrolling list) appears only when there's more than one provider; a single-provider list (Anthropic-only, or `FALLBACK_MODELS`) stays flat like before, so the common case doesn't grow a redundant "Anthropic" heading over 4 rows.
- **Scrolls.** The listbox caps at `360px` and scrolls internally rather than growing — real machines return 20+ rows across three providers, which routinely exceeds the space under a trigger sitting mid-modal. On open, the current selection is scrolled into view (`scrollIntoView({block:'nearest'})`) rather than always landing at the top, so re-opening a picker already on an Ollama model doesn't require scrolling past Anthropic and back to confirm it.
- Closes on outside click and Escape.
- `note` (the `note` prop, not a row's `.note`) heads the open listbox when the list needs explaining — `Cannot reach http://box:11434`. An empty picker with no reason makes an unreachable endpoint look identical to one with nothing installed.
- `inheritNote` replaces the Default row's `inherits your Claude Code default`, which is only true on a Claude Code provider. On anything else the caller says what Default actually inherits.
- `onChange(id, model)` — `model` is the full clicked row (or the inherit row), so a caller that needs to persist `providerId` alongside the model id can. The second argument is additive: a caller that only reads the first (`(v) => setX(v)`) keeps working unchanged.
- A row's `note` is exactly what the server wrote and is rendered verbatim — never re-derived from `cost`/`costBasis` here. That is what keeps a row Foreman cannot price (`costBasis` other than `priced`) from ever growing a dollar figure it doesn't have; the wording lives entirely on the server, one place, in `describeModel()`. Note that `free` and `unpriced` are different rows to a reader — one is your own hardware, the other is somebody's bill — so never write copy that treats "not priced" as one state.

With more than six models the menu opens with a focused filter box at the top: it narrows by label, id, provider and note ("cloud", "codex", "haiku", "cheap"), group headings keep their counts for what remains, Enter picks the first match, and an empty result says so. The Default row hides while filtering.

`block` makes the picker fill its container — trigger and menu edge to edge — for stacked forms and panels; the default inline size is for rows and tables.
