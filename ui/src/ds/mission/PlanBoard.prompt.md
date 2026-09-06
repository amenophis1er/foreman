Bottom of the right rail: what the director planned and how far it has got.

```jsx
<PlanBoard doc={run.missionDoc} />
```

- The `n/m` counter sits beside the section title in muted ink; there is no progress bar.
- Done items get a check in `--status-good`, muted ink, and a strikethrough; open items get a hollow circle. A 3px progress bar sits under the title.
- `raw doc` toggles the full markdown into an inset `pre` — Foreman always lets you see the underlying artifact.

The board parses checkboxes from every section of MISSION.md except DONE WHEN: the criteria have their own pinned list, and counting them here too doubled them.
