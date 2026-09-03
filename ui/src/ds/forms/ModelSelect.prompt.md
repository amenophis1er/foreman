Picks the model for a role. Appears twice in the composer — Director and Workers — and nowhere else.

```jsx
const { models, loading } = ModelSelect.useModels('/models'); // once, in the screen
<ModelSelect value={directorModel} onChange={setDirectorModel} models={models} loading={loading} />
```

- The list is server-provided (`GET /models` → `{models:[{id,label,model,cost,note}]}`), never hard-coded in a screen. `FALLBACK_MODELS` covers the gap before the endpoint answers.
- Trigger: cpu icon · label · chevron, 150px min. While loading it reads "Fetching models…" and is disabled.
- Menu rows: check (selected, gold) · label + exact model id in mono · one-line note · four-bar cost mark. "Default" is always the first row and means inherit.
- Closes on outside click and Escape. No search, no groups — the list is short by design.
