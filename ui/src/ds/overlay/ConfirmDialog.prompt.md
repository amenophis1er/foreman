The one confirmation shape. Title is a question, body states what is kept and what is lost, the confirm button repeats the verb.

```jsx
{confirm && (
  <ConfirmDialog icon="unlink" title={`Unlink ${confirm.name}?`}
    body="Foreman stops tracking this folder. Run history and MISSION.md are kept on disk."
    confirmLabel="Unlink" onConfirm={doUnlink} onCancel={() => setConfirm(null)} />
)}
```

Never use it for reversible actions (filters, theme, collapse).
