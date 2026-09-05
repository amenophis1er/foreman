Shows the state of a run or an agent. Appears in project headers, fleet cards, agent rows, and run history rows.

```jsx
<StatusBadge status="running" />
<StatusBadge status="interrupted" />
```

- Six states only: `idle`, `running`, `done`, `error`, `interrupted`, `needs-you`. There is no "queued", "paused", or "pending".
- `needs-you` is `running` with a pending approval or question: warning color, bell glyph, label `needs you`. A run blocked on a human must not read `running` — that is the standing rule in `docs/crew-resilience.md`. Only the project header substitutes it; run history and agent rows never show it.
- Labels are lowercase, one word.
- Do not restyle it into a colored fill; the pill is always `--bg-inset` on a `--line` hairline so the status glyph is the only color in it.
