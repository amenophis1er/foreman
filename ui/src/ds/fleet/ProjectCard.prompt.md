One card per linked folder on the fleet home. Lay them out in `repeat(auto-fill, minmax(300px, 1fr))` with a 16px gap, capped at 1200px.

```jsx
<ProjectCard name="Alpha" folder="/Users/you/Projects/alpha"
  run={{ mission: 'Add tests for the store reducer', costUsd: 1.24, budgetUsd: 5 }}
  pendingQuestions={1} onOpen={open} onUnlink={() => setConfirm(p)} />
<ProjectCard name="Beta" folder="/Users/you/Projects/beta"
  lastRun={{ mission: 'Refactor the store reducer', status: 'done', createdAt: t, costUsd: 2.9 }} />
```

- Four states: never run (muted hint), idle with last-run summary, running (2-line clamped mission + BudgetMeter), needs-you (warning border + pulsing strip).
- `Unlink` is a quiet corner action that must open a `ConfirmDialog`; the card itself never unlinks.
