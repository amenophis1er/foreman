The `Crew` tab of the mission body. Who is on the run, what each is doing, and the run's own settings.

```jsx
<CrewTab agents={run.agents} filter={filter} onFilter={toggle} sessionId={run.directorSessionId}
  details={<RunDetails r={selectedRun} live={viewingLive} … />} />
```

- Two columns on one row: the crew tree on the left, the run block on the right. Both use `minmax(0, 1fr)` so a long worker brief cannot widen the tab.
- The tree is `AgentRow` — director on top, workers indented with the tree connector — exactly as the left rail drew it. Under each worker, its current line: the latest `report_progress` status once it has reported, the brief's first line before that, clamped to two lines. The row's tooltip carries the same text; the line exists so it can be read without hovering.
- Clicking an agent filters the transcript to it (the view switches to the Transcript tab); the sentence under the tree says which filter is on and how to clear it.
- `details` is the run-properties grid (models, budget with live edit, browser toggle, resumes) — the tab does not own that content, it hosts it. The director session id sits last, mono, first 8 chars.
- Crew is a tab and not a pinned rail because the human decided so (crew-resilience.md item 10): it is looked at when wanted, and should not take a column from every transcript line.
