Directly under the project header, full width. The first thing on the screen after the title, and the answer to "what does this run need from me right now".

```jsx
<NowStrip approvals={run.approvals} questions={run.questions} now={now}
  running={run.runStatus === 'running'} activity={{ line: 'worker-1: writing styles.css', agent: 'worker-1', crew: 'director · 2 workers' }}
  onAllow={(id) => api.permission(id, 'allow')} onAlways={(id) => api.permission(id, 'allow_always')}
  onDeny={(id) => api.permission(id, 'deny')} onAnswer={(id, text) => api.answer(id, text)} />
```

- Exists because of the twelve-minute miss: a run sat on an unanswered Write approval while the header said `running` and the transcript simply stopped. The card was on screen — in a right-hand rail nobody was watching. Needs-you is never in a side panel; it is here, above everything, and nothing may be placed between the header and this strip.
- With asks pending: `--brand-wash-strong` background, a 2px `--status-warning` top rule, and the bell line in `.pulse` (the only thing in Foreman that animates for attention). Each ask is the full `ApprovalCard` (with `escapedPath`) or `QuestionCard` (with `options`), preceded by its `waiting 12m` line — the same cards as everywhere else, so answering here is answering.
- With nothing pending and the run live: one plain line on the panel surface — the crew's latest progress or the director's latest sentence, its agent dot, and the crew count at the right. It says what is happening so the reader does not have to scroll the transcript to find out.
- Idle and nothing pending: not rendered. The strip has no empty state; the header's status badge already says `done`.
- The strip caps at 55vh and scrolls inside itself, so a stack of asks never pushes the body off screen.
