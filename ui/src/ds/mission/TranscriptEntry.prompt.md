The unit of the live transcript. Stack in a scroll container pinned to the bottom (unpin when the user scrolls up >60px).

```jsx
<TranscriptEntry agent="director" title="init" kind="system" body="model: claude-fable-5-1" ts={t} />
<TranscriptEntry agent="director" kind="text" body="I'll write the mission file first, then ask you for the filename." ts={t} />
<TranscriptEntry agent="worker-1" title="Write" kind="tool" body={JSON.stringify(input)} ts={t} />
<TranscriptEntry agent="director" title="ask_human" kind="tool" body={payload} ts={t} />
<TranscriptEntry agent="worker-3" kind="review" ts={t} costBasis="priced"
  review={{ name: 'House reviewer', model: 'claude-opus-5', pass: false, findings, costUsd: 0.42 }} />
```

- Tool entries render a collapsed `ToolCall` chip; Foreman's own MCP tools get a gold chip and an `orchestration` tag in the meta row.
- `dense` collapses a tool entry to one mono line in `--ink-2` — dot, tool icon, name, the first ~90 chars of the summarised args, time — with no card. Weight follows meaning: a run makes hundreds of tool calls and a handful of decisions, and the mission transcript is read for the decisions. The raw payload stays in the line's tooltip; the deck shows what the writes amounted to. Prose, results, errors, steers and system lines ignore `dense`.
- Prose keeps the agent's identity accent; errors go critical with an `X` beside the label.
- `review` is a crew reviewer's verdict, accented by its outcome: PASS in `--status-good`, FAIL in `--status-serious` — the tone Foreman already uses for `interrupted` and for a caution banner. **A FAIL is never `--status-critical`.** Nothing crashed; a reviewer did its job and the answer was no, and critical in this app means a crash. The word PASS/FAIL carries the meaning and the colour only agrees with it. The header row reads dot · worker · reviewer name · model · cost · badge · time; the findings fold on the same "Show all" as any long body and render as prose — a bullet a reviewer wrapped by hand is rejoined onto its own bullet rather than becoming a flush-left paragraph of its own, and a dollar appears only when `costBasis === 'priced'`. Empty findings read "Nothing to raise."
- Timestamps are 24-hour `HH:MM:SS`, tabular, right-aligned.


A `result` body longer than about twelve lines is folded: the first lines show, then "Show all · N lines". Payloads are evidence, not narrative.

An end-of-turn marker whose text duplicated the card above renders as one quiet line, "turn ended · success", not an empty card. A worker's report echoed back to the director as a tool result renders as a one-line receipt ("worker-6 finished — first sentence"); the full report is on the worker's own card.
