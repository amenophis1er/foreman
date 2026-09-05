Mission history, under a `Runs` SectionTitle in the left rail.

```jsx
<RunRow mission={r.mission} createdAt={r.createdAt} costUsd={r.costUsd} status={r.status}
  selected={r.id === selectedRunId} onSelect={() => select(r.id)} />
```

- The run's identity is its generated `title` when there is one, falling back to the mission brief — there are no run ids in the UI. The full brief is always the tooltip.
- Meta line is always date · cost · status, in that order.
- Selected rows lift to `--bg-card` with a `--line-strong` border; unselected rows are transparent.


Spend follows `costBasis`: a `priced` run shows `$2.44`, an `unpriced` run shows `5.8m tok` from `usage`, a `free` run shows no spend at all. Never a dollar figure the run's provider did not put on a bill.
