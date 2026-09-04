The identity system: gold means the director; each worker gets a fixed hue from a six-step violet ramp keyed on its index, so `worker-1` is the same color in every run.

```jsx
<AgentDot agent="director" />
<AgentDot agent="worker-2" size="sm" />
<Card accent={agentColor(entry.agent)}>…</Card>
```

- Colors are assignments, not a cycling palette: `worker-3` is always `--agent-worker-3`. The ramp stays inside the violet family so "violet = worker" still reads at a glance.
- Identity color appears on dots, timeline lanes, and 3px card accents — text never wears it, except `Director asks:` and approval titles.
