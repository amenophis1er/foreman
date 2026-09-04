The crew list for the selected run: director first, then its workers, indented.

```jsx
<AgentRow agent="director" status="running" selected={filter === 'director'} onSelect={toggle} />
<AgentRow agent="worker-1" status="done" indent task={w.task} onSelect={toggle} />
```

- Ids are shown exactly as the orchestrator names them; do not prettify `worker-1` into "Worker 1".
- Selection is a transcript filter, not navigation. Under the list, show `Filtering to <b>worker-1</b> — click again to clear.`
- The rail footer carries `director session <first 8 chars>` in mono muted text.
