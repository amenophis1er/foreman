The planning conversation's input, docked at the bottom of the transcript column while a project is idle.

```jsx
<ChatBar busy={chat.thinking} onSend={(t) => chat.send(t)} />
<ChatBar disabled disabledReason="A mission is running — steer the director instead." />
```

- Same shell as `SteerBar` (card surface, brand focus border, auto-grow textarea to 160px, ⌘↵ sends) minus the recipient chip and timing tabs. One listener, nothing to interrupt.
- The footer line is a standing reminder of the contract: `Reads the project, never changes it.` It becomes `The foreman is looking…` while a turn is in flight.
- Waiting borrows the existing `.pulse` class on the icon. Do not add a spinner — the design system moves two things and no more.
