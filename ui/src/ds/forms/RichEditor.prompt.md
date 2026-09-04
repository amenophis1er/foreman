The composer's writing surface. Markup is highlighted in place while the text stays plain — no WYSIWYG, no hidden formatting.

```jsx
<RichEditor ref={ta} value={brief} onChange={setBrief} placeholder={PLACEHOLDER} onKeyDown={submitOnCmdEnter} />
```

- `code` → inset pill, violet text, dimmed backticks. ``` fences → inset band, 6px radius, indented 6px from the editor edges, no rule; the fence markers themselves are hidden (only a language tag shows, dimmed).
- Typing ``` at a line start auto-closes the block and puts the caret inside. Typing the closing ``` always leaves a blank line below it, so ↓ steps out of the block.
- `>` quote → secondary ink with the same rule. `-` and `#` markers turn gold. `<slot>` → gold wash.
- Implementation rule: the overlay may only change colour, background and box-shadow. Anything that moves glyphs (weight, padding, font family) would desync it from the caret, so bold and mono are left to Preview.
- Grows with content to `maxHeight`, then scrolls both layers together.
