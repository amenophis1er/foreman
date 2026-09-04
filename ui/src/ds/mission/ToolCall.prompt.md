Replaces raw JSON in the transcript and approval cards with something an operator can scan.

```jsx
<ToolCall tool="Edit" input={{ file_path: 'src/store.ts', old_string: 'let x = 1', new_string: 'const x = 1' }} />
<ToolCall tool="Bash" body='{"command":"npm test"}' defaultOpen />
<ToolCall tool="spawn_worker" input={{ id: 'worker-1', task: 'Create hello.txt…' }} />
```

- Collapsed by default in the transcript; `defaultOpen` in approval cards, where the operator must see what they are allowing.
- Diff rows: red `−` for `old_string`, green `+` for `new_string`/`content`, capped at 8–12 lines with an "N more lines" note. `raw` shows the whole payload — nothing is ever hidden, only folded.
- Summaries shorten paths to the last three segments; the full path is in the raw view.
