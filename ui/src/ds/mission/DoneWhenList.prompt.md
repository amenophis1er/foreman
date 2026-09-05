Beside the transcript on wide screens (300px column); a disclosure above it on narrow ones. The mission's finish line, live.

```jsx
<DoneWhenList doc={run.missionDoc} />
```

- Parses only the `## DONE WHEN` section — checkbox lines up to the next heading — with the exact rule the server's `unmetCriteria` uses. What this list shows unmet is what would stop the run being called done; the plan's own checkboxes further down the doc are `PlanBoard`'s business, not this one's.
- The count reads `5 / 7` beside the label, tabular, and turns `--status-good` when every criterion is ticked. Ticked items get a `--status-good` check, muted ink and a strikethrough; open ones a hollow circle in `--ink-2`. No progress bar — seven lines are their own progress bar.
- Three empty states, each one line: no doc yet, a doc without a DONE WHEN section, and (never rendered as empty) a section with criteria. It does not invent criteria from a doc that has none.
- `doneWhenLabel(parseDoneWhen(doc))` is exported so the narrow-layout disclosure can show `Done when · 5 / 7` while closed.
