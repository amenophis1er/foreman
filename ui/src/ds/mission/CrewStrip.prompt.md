Medium-width replacement for the crew list: the same filter behaviour, one line tall.

```jsx
<CrewStrip agents={run.agents} filter={filter} onFilter={toggle} />
```

Chips carry the status as an icon only because the pill is already labelled by the agent id; the status word is one hover away in the tooltip. Use `AgentRow` wherever there is room for the full badge.
