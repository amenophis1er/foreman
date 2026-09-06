Top of every view. Foreman has no sidebar navigation and no user menu — this bar plus the fleet grid is the whole navigation model.

```jsx
<AppHeader mode="fleet" theme={theme} onToggleTheme={toggle}>
  <Banner tone="disconnected" inline>disconnected</Banner>
</AppHeader>

<AppHeader mode="project" title={p.name} folder={p.folder} onBack={toFleet} theme={theme} onToggleTheme={toggle}>
  <StatusBadge status="running" />
  <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} />
  <Button variant="danger" onClick={interrupt}>Interrupt</Button>
</AppHeader>
```

- Fleet mode shows the `Logo` lockup with the lowercase tagline `mission control`.
- Right-slot order in project mode: inline error · status · budget · actions (Interrupt / Resume / New mission) · theme toggle.
- Set the theme by putting `data-theme="light"` on `<html>`; persist it in localStorage as `foreman:theme`.

Project mode keeps the F mark at the left as the way back to the fleet, in place of the arrow icon; the "Fleet" crumb beside it does the same. The brand is on every screen.

The far right carries the running version in quiet mono (`v0.1.4`), linked to the GitHub releases — the answer to "what am I running" when something looks off, never louder than that.
