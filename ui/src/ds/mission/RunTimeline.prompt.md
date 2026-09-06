Answers "who was doing what, when" at a glance — the parity gap the transcript's timestamps could not close.

```jsx
<RunTimeline agents={run.agents} entries={run.entries} live={run.runStatus === 'running'}
  selected={filter} onSelect={toggleFilter} />
```

- Lives above the transcript as a compact strip (22px lanes), or as its own tab at 32px lanes on narrow layouts.
- Lane colors are identity colors; tick colors mean event kind. Hover a tick for `HH:MM:SS · title`.
- Selecting a lane is the same filter as clicking an `AgentRow`; keep the two in sync.

The lanes carry a shared ruler: faint gridlines at round wall-clock times (aimed at five or six across the run), labelled on the scale below, with the run's total duration in bold at the right. An hour-long run and a two-minute one must not look the same.
