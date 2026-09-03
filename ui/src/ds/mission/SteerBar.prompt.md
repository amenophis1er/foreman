Stepping in mid-run. Questions and approvals are the agent asking you; steering is you talking first.

```jsx
<SteerBar agents={agents} onSend={(text, { to, timing }) => api.steer(runId, { to, text, timing })} />
<SteerBar disabled disabledReason="Run finished — start a new mission." />
```

- Lives at the bottom of the transcript column, always in the same place, so the operator never hunts for it. Hidden nowhere: when the run is idle it stays, disabled, with a reason in the placeholder.
- One line that grows to four; ⌘↵ sends. The gold `steer` icon at the left marks it as an operator voice, matching the gold `Director asks:` on the other side of the conversation.
- Recipient chip defaults to `director`; the menu lists the director plus running workers only. Steering a finished worker is meaningless.
- Timing is a two-way switch: `Next turn` (default, safe: delivered before the next tool call) · `Now` (interrupts the current tool call). The caption on the right spells out the consequence of the selected option.
- Send is a `default` button, never `primary` — `Answer` owns primary in this view.
- The sent note is echoed into the transcript as `TranscriptEntry kind="steer"` (agent `you`, header `you → director · next turn`) so the record shows exactly what the agent was told and when.
