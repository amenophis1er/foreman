Shown when an agent's tool call needs the human. Stack them in the right rail under an `Approvals` SectionTitle.

```jsx
<ApprovalCard agent="worker-1" title="Wants to use Bash" decisionReason="writes outside the project folder"
  input={{ command: 'rm -rf build' }} onAllow={allow} onAlways={always} onDeny={deny} />
```

- Three buttons, right-aligned, always in this order: Allow · Always (run) · Deny. The middle one is scoped to the run, and the label says so.
- When `escapedPath` is set (the ask came from the folder boundary) the middle button reads `Allow this path (run)` and its tooltip names the directory. There "always" opens that path for the run, not the tool — the label must say which, or a correct grant looks broken when the next outside path prompts again.
- The payload is shown raw and unabridged in mono — Foreman never hides what an agent is about to do.
- `Allow`/`Always` are `good` outline, `Deny` is `danger` outline; none of them fill.
