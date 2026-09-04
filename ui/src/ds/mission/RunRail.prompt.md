Put this inside the left `Rail` of the project view. It makes the hierarchy explicit: a run has a crew; history is other runs.

```jsx
<Rail side="left">
  <RunRail current={{ id: 'live', mission: run.mission, costUsd: run.costUsd, status: run.runStatus, live: true }}
    agents={run.agents} history={history} selectedRunId="live"
    filter={filter} onFilter={toggle} onSelectRun={select} sessionId={run.directorSessionId} />
</Rail>
```

- Section titles read `This run` (live) or `Selected run` (replay), then `Mission history`.
- The crew block is indented under the run row with a hairline; workers nest one level further with tree connectors.
