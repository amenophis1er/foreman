Renders operator or agent prose with a small, fixed markup set. Used by the composer's Preview tab.

```jsx
<RichText text={brief} />            // slots highlighted (template fill-ins)
<RichText text={entry.body} slots={false} />  // agent text
```

- Fenced ``` blocks: inset surface, mono 12px, language tag top-right. Inline `code`: inset pill, mono.
- `>` quotes: 2px violet left rule, secondary ink. `-` lists, `##` headings, `**bold**`.
- `<slot>` becomes a dashed gold pill — the operator can see what still needs filling in.
- Nothing else is parsed. No links, no images, no HTML.

Inside a body set in `--ink-prose`, bold and headings stay on `--ink-0`: the dimmer paragraph is the ground, the emphasis is the figure.
