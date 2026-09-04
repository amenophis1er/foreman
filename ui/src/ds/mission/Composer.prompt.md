The project view's idle state. Everything needed to launch a mission fits above the fold.

```jsx
const { models, loading } = ModelSelect.useModels('/models');
<Composer folder={p.folder} defaultBudgetUsd={p.defaultBudgetUsd} models={models} modelsLoading={loading} error={err} onStart={start} />
```

- `Start from` chips (Bug fix · Add tests · Refactor · Audit) fill the brief with a skeleton — Done when / Constraints / Ask me before — and pre-set budget and models. Slots are `<angle brackets>`; Preview shows them as dashed gold pills.
- The editor frame: Write / Preview tabs on the left; quote, inline code and code block insertion on the right (they wrap the selection). Write is a `RichEditor` — markup is coloured live in place (Notion-style): `code` pills, ``` bands, quotes, slots. Preview (`RichText`) is the fully rendered form with real mono and bold. The frame border turns gold while a file is dragged over it.
- Attachments: paperclip button, drop on the editor, or paste an image. Chips sit in the footer row; × removes. They travel with `onStart` as `attachments`, never with the saved draft.
- The parameter tray uses stacked fields: `Budget cap` (`$` prefix, hard stop), `Director`, `Workers`. Both pickers read the same `models` list from the endpoint.
- The draft autosaves 400ms after typing, keyed by folder; "Draft restored" shows on return, `Clear` wipes text and attachments.
- Start is disabled until the brief has content; ⌘/Ctrl+Enter from the textarea also starts.
- The placeholder coaches the operator to say what done looks like and to flag decisions. Keep it verbatim.
