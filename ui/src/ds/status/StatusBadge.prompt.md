Shows the state of a run or an agent. Appears in project headers, fleet cards, agent rows, and run history rows.

```jsx
<StatusBadge status="running" />
<StatusBadge status="interrupted" />
```

- Five states only: `idle`, `running`, `done`, `error`, `interrupted`. There is no "queued", "paused", or "pending".
- Labels are lowercase, one word.
- Do not restyle it into a colored fill; the pill is always `--bg-inset` on a `--line` hairline so the status glyph is the only color in it.
