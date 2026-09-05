One running mission, as a row of the board's "Running" list.

```jsx
<div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--bg-card)' }}>
  {running.map((p) => (
    <FleetRunRow key={p.id} name={p.name} folder={p.folder}
      title={p.activeRun.title} mission={p.activeRun.mission} activity={activity[p.id]}
      costUsd={p.activeRun.costUsd} budgetUsd={p.activeRun.budgetUsd}
      costBasis={basisOf(p.activeRun)} usage={p.activeRun.usage} turns={p.activeRun.turns}
      directorModel={p.activeRun.directorModel} workerModel={p.activeRun.workerModel}
      createdAt={p.activeRun.createdAt} onOpen={() => go(p.id)} />
  ))}
</div>
```

- A row, not a card. The running section is scanned down — who · what · how far · how much — and rows keep those in the same four columns across projects. The caller draws the list's border and hairlines between rows; the row draws only itself.
- Columns: name with the folder mono beneath · the title (or brief) with the crew's line mono beneath · `BudgetMeter` · models and elapsed, right-aligned.
- The crew's line is the `activity` the fleet already tracks per project (`worker-1: writing styles.css`). It is the answer to "is it doing anything": a line that has not changed between two glances is the stall the meter cannot show. The `.ticker` class flashes it in when it changes.
- Models are shown as full ids, `director · worker`. Shorten only if width forces it; a truncated id is worse than a wrapped one.
- Elapsed is since `createdAt`, in the same `3m` / `1h 12m` form the needs strip uses for waiting.
- Not named `RunRow`: that is the history line in ds/mission.
- The whole row is the click target; there is no unlink here — you do not unlink a project mid-mission from a list.
