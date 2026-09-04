The fleet's filter, in a row of its own between `AppHeader` and the card grid, aligned to `--fleet-max` like the grid below it.

```jsx
<FleetSearch value={q} onChange={setQ} count={shown.length} total={projects.length} />
```

- Shown once a fleet has more than one project; a single card needs no filter.
- Matches name, path and the current or last mission — the long `/private/tmp/...` paths are often the only thing that tells two projects apart.
- `/` focuses it from anywhere on the page; Escape clears it, then blurs on a second press. The `/` hint sits where the clear button will be, so nothing shifts when the first character is typed.
- `count of total` appears only while filtering. An idle fleet does not need to be told how many projects it has.
- Filtering never reorders: the server's urgency ordering survives, so a blocked project stays at the top of whatever is left.
