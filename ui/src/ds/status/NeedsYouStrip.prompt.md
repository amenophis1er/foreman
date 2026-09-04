Tells the operator, at fleet zoom, that a mission is blocked on them.

```jsx
<NeedsYouStrip approvals={p.pendingPermissions} questions={p.pendingQuestions} />
```

- The `.pulse` class (opacity 1 ↔ 0.55, 1.6s) is reserved for this. Nothing else in Foreman animates for attention.
- The counts are pluralised and joined with a comma; the copy is lowercase after the bell.
- Pair it with the card's warning border — the strip alone is not the whole signal.
