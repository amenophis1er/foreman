A project with nothing running: its last outcome on one compact tile in the board's "Recent" grid.

```jsx
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--sp-3)' }}>
  {recent.map((p) => (
    <OutcomeTile key={p.id} name={p.name} folder={p.folder} lastRun={p.lastRun}
      onOpen={() => go(p.id)} onUnlink={() => setUnlinking(p)} />
  ))}
</div>
```

- Third on the board, after needs-you and running: what finished matters less than what is happening, and the layout says so.
- Reads: name with the folder mono at the right · the last run's title or brief, one line · `StatusBadge` · date · spend.
- The spend rule, and the reason this file exists at all: **a dollar only when `costBasis === 'priced'`; `5.8m tok` when `usage` is known; nothing otherwise.** `$30.14` once sat on this tile for a run on free and unpriced models — Anthropic's price table applied to Ollama tokens. The old card also printed a dollar when the basis was *absent*; this tile does not. An unknown basis is unknown, not priced.
- A **reviewed** mark — an eye with a check, composed from the two icons the set already has, no new glyph — sits beside the badge when `status === 'done'` and `reviewedBy` names at least one reviewer. The tile applies no rule of its own: it cannot check whether a PASS is against the run's final diff, because it has no diff hash. It does not need to. Foreman records `done` only once every required reviewer passed on the diff as it then stood, and downgrades the run to `interrupted` otherwise — so `done` *is* the currency check, and a stale PASS never reaches this tile. A run nothing required a review of shows nothing, and so does a running one. It wears `--ink-2` and follows a separator dot like every other fact on the meta row: in the badge's own green, abutting the badge, it read at tile scale as a smudge on the pill rather than a second thing being said. The pair is one `role="img"` with an `aria-label` naming the reviewers, so keyboard and touch get the meaning the tooltip only gives a mouse.
- A project with no runs says `No missions yet — open to compose one.` in muted ink; no badge, no date.
- Unlink is revealed under the cursor in a row that is always laid out, so nothing shifts. It stops propagation and should open a `ConfirmDialog`.
- The whole tile is the click target and is keyboard-reachable (Enter / Space open).
