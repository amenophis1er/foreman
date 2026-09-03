The escalation path: the director never guesses on a flagged decision, it asks here.

```jsx
<QuestionCard question={q.question} onAnswer={(a) => api.answer(q.id, a)} />
```

- The heading is always the literal string `Director asks:` in brand gold — one of only two places text wears an identity color.
- The question renders as written by the agent (pre-wrap); never truncate or summarise it.
- One `primary` button, labelled `Answer`, right-aligned under the reply box. There is no skip or dismiss.
