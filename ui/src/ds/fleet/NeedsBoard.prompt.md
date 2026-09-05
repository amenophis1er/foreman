Every pending ask in the fleet, one strip each, first on the board and answerable where it stands.

```jsx
<NeedsBoard items={needs}
  onPermission={(it, b) => api.permission(it.id, b).then(toError)}
  onAnswer={(it, text) => api.answer(it.id, text).then(toError)}
  onPlanner={(it, text) => post('/chat/answer', { projectId: it.projectId, id: it.id, answers: { [it.text]: text } }).then(toError)}
  onOpen={(projectId) => go(projectId)} />
```

- Why it exists: a run once sat twelve minutes on an unanswered Write approval while the fleet said `running`. The ask was in a rail on a screen nobody had open. Needs-you is never in a side panel; on the fleet it is the first thing under the header, and the answer is one click away without leaving the page.
- Warning border and `--brand-wash-strong` fill, pulsing with the `.pulse` class — the same signal `NeedsYouStrip` carries, at full width, because this is the one thing on the page that wants you.
- Each strip reads: project name · kind (`approval` / `director asks` / `the planner is asking`) · the one-line text · `waiting 3m`.
- Permission: `Allow` / `Deny` only. Never `Always (run)` from the board — that grant opens a tool or a path for the rest of the run and belongs on the screen that shows what it opens.
- Question or planner with options: one button per option, the first marked `★` (the planner's recommendation), plus `type…` which reveals a one-line input. Without options the input is shown directly. Enter sends; Escape hides the input again.
- The planner's ask may carry several questions. The board answers only the first one — `text` is that question, and the answer goes up as `{ [text]: choice }`. `open` takes the human to the chat picker for the rest.
- `open` is always there, a ghost button at the right: the strip is a summary, not the evidence, and a payload worth reading before allowing lives on the project screen.
- Busy and error state are per strip. Controls disable while the call is in flight and stay disabled on success until the next poll removes the strip. A failure prints inline in danger ink — the usual cause is an ask that timed out between the poll and the click.
- `summary` items are the fallback for a server that has not sent `needs` yet: counts as a sentence, `open` as the only action.
- The board does not sort; hand it items in the order they should be read (project urgency, then age).
