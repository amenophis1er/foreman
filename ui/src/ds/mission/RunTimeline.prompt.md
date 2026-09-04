Answers "who was doing what, when" at a glance — the parity gap the transcript's timestamps could not close.

```jsx
<RunTimeline agents={run.agents} entries={run.entries} live={run.runStatus === 'running'}
  selected={filter} onSelect={toggleFilter} />
```

- Lives above the transcript as a compact strip (22px lanes), or as its own tab at 32px lanes on narrow layouts.
- Lane colors are identity colors; tick colors mean event kind. Hover a tick for `HH:MM:SS · title`.
- Selecting a lane is the same filter as clicking an `AgentRow`; keep the two in sync.
