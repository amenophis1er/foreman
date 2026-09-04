Mission history, under a `Runs` SectionTitle in the left rail.

```jsx
<RunRow mission={r.mission} createdAt={r.createdAt} costUsd={r.costUsd} status={r.status}
  selected={r.id === selectedRunId} onSelect={() => select(r.id)} />
```

- The run's identity is its generated `title` when there is one, falling back to the mission brief — there are no run ids in the UI. The full brief is always the tooltip.
- Meta line is always date · cost · status, in that order.
- Selected rows lift to `--bg-card` with a `--line-strong` border; unselected rows are transparent.
