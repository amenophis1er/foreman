The planning conversation's input, docked at the bottom of the transcript column while a project is idle.

```jsx
<ChatBar busy={chat.thinking} onSend={(t) => chat.send(t)} />
<ChatBar disabled disabledReason="A mission is running — steer the director instead." />
```

- Same shell as `SteerBar` (card surface, brand focus border, auto-grow textarea to 160px, ⌘↵ sends) minus the recipient chip and timing tabs. One listener, nothing to interrupt.
- The footer line is a standing reminder of the contract: `Reads the project, never changes it.` It becomes `The foreman is looking…` while a turn is in flight.
- Pass `who={chat.who}` and the footer leads with **who is answering** in mono — `sonnet · Claude Code — Reads the project…`, `glm-5.3-flash:cloud · Ollama · unpriced — …`. It comes from the server on every `chat_turn` (and from `GET /chat` before the first), so a Settings change shows on the next reply. Never derive it client-side; the server is the only party that knows which provider actually resolved.
- When the planner asks a question with options, `ProjectView` swaps this bar for `QuestionPicker` in the same slot. They never render together.
- Waiting borrows the existing `.pulse` class on the icon. Do not add a spinner — the design system moves two things and no more.
