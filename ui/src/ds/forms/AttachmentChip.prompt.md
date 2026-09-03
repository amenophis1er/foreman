One attached file, shown in the composer's footer row (and in a run's header when the brief had attachments).

```jsx
<AttachmentChip name="schema.sql" size={4821} onRemove={() => remove(i)} />
```

- 24px tall, inset surface, hairline; name in mono 11px, truncated at 260px; size in 11px muted.
- Icon by extension: `image` for raster/svg, `code` for source files, `file` otherwise.
- Read-only chips omit `onRemove` — no × is drawn.
