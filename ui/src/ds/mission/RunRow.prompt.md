Mission history, under a `Runs` SectionTitle in the left rail.

```jsx
<RunRow mission={r.mission} createdAt={r.createdAt} costUsd={r.costUsd} status={r.status}
  selected={r.id === selectedRunId} onSelect={() => select(r.id)} />
```

- The mission text is the run's identity — there are no run names or ids in the UI.
- Meta line is always date · cost · status, in that order.
- Selected rows lift to `--bg-card` with a `--line-strong` border; unselected rows are transparent.
