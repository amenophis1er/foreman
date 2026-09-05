The unit of the live transcript. Stack in a scroll container pinned to the bottom (unpin when the user scrolls up >60px).

```jsx
<TranscriptEntry agent="director" title="init" kind="system" body="model: claude-fable-5-1" ts={t} />
<TranscriptEntry agent="director" kind="text" body="I'll write the mission file first, then ask you for the filename." ts={t} />
<TranscriptEntry agent="worker-1" title="Write" kind="tool" body={JSON.stringify(input)} ts={t} />
<TranscriptEntry agent="director" title="ask_human" kind="tool" body={payload} ts={t} />
```

- Tool entries render a collapsed `ToolCall` chip; Foreman's own MCP tools get a gold chip and an `orchestration` tag in the meta row.
- `dense` collapses a tool entry to one mono line in `--ink-2` — dot, tool icon, name, the first ~90 chars of the summarised args, time — with no card. Weight follows meaning: a run makes hundreds of tool calls and a handful of decisions, and the mission transcript is read for the decisions. The raw payload stays in the line's tooltip; the deck shows what the writes amounted to. Prose, results, errors, steers and system lines ignore `dense`.
- Prose keeps the agent's identity accent; errors go critical with an `X` beside the label.
- Timestamps are 24-hour `HH:MM:SS`, tabular, right-aligned.


A `result` body longer than about twelve lines is folded: the first lines show, then "Show all · N lines". Payloads are evidence, not narrative.
