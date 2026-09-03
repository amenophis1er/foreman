The single button in Foreman; use it for every action and let `variant` carry the intent.

```jsx
<Button variant="primary" onClick={start} disabled={!mission.trim()}>Start mission</Button>
<Button variant="danger" onClick={interrupt}>Interrupt</Button>
<Button variant="good" icon="resume" title="Restore the director's session and continue" onClick={resume}>Resume</Button>
<Button icon="back" onClick={toFleet}>Fleet</Button>
<Button variant="ghost" size="sm" icon="unlink" onClick={askUnlink}>Unlink</Button>
```

- `primary` is brand-filled gold — at most one per view (Start mission / Answer / Select this folder / New mission).
- `good` and `danger` are outline-only; they never fill, so an approval card reads as a choice rather than a warning.
- `ghost` is the quiet action; `size="sm"` makes it a chip (composer templates, raw toggles).
- Action rows in cards (approvals, questions, dialogs) are right-aligned: `justify-content: flex-end`.
- Icons are leading, semantic, and optional; the label is never dropped.
- Disabled is `opacity: 0.5` and keeps its label; show progress by changing the label (`Resuming…`), never a spinner.
