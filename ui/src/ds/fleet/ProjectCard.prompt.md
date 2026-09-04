One card per linked folder on the fleet home. Lay them out in `repeat(auto-fill, minmax(var(--card-min), 1fr))` with a 16px gap, capped at `--fleet-max`.

```jsx
<ProjectCard name="Alpha" folder="/Users/you/Projects/alpha"
  run={{ mission: 'Add tests for the store reducer', title: 'Store Reducer Test Coverage', costUsd: 1.24, budgetUsd: 5 }}
  pendingQuestions={1} onOpen={open} onUnlink={() => setConfirm(p)} />
<ProjectCard name="Beta" folder="/Users/you/Projects/beta"
  lastRun={{ mission: 'Refactor the store reducer', title: 'Store Reducer Refactor', status: 'done', createdAt: t, costUsd: 2.9 }} />
```

- Two halves split by a hairline: identity above (name, `~`-shortened path, optional install), mission below. The lower half is `margin-top: auto`, so missions line up on one baseline across the grid however long the paths are.
- Four states: never run (muted hint), idle with last-run summary, running (mission + BudgetMeter + activity ticker), needs-you (warning border + stripe + pulsing strip).
- **Colour is only ever spent on live state.** A `--accent-w` left stripe is brand for running, warning for needs-you, and `--line-strong` on hover for an idle card. A finished run's outcome lives in the meta row's StatusBadge, never in the stripe — a card should not still be green tomorrow.
- No `idle` badge. Every card is idle most of the time; a label that says nothing should not hold the strongest position on the card. Absence is the idle state.
- A run's `title` is its display name wherever one exists; the brief stays in the tooltip. Only an untitled running mission spends two clamped lines on the brief.
- `instance` adds a mono `via <path>` line under the folder, and only when the project pins a Claude Code install. Projects on the server default show nothing — the line's presence is what carries the meaning.
- `Unlink` fades in on hover only and must open a `ConfirmDialog`; the card itself never unlinks. Its row is always laid out, so revealing it moves nothing.
- Linking a project is a header action, not a trailing tile in this grid — see `FleetView`.
