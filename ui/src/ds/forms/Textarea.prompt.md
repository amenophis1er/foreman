Mission briefs and answers to the director. Two fixed sizes, no auto-grow.

```jsx
<Textarea size="mission" value={mission} onChange={setMission}
  placeholder={'Describe the mission…\n\nSay what "done" looks like, name constraints, and flag any decision the director should ask you about before implementing.'} />
<Textarea size="answer" value={answer} onChange={setAnswer} />
```

The composer placeholder is load-bearing coaching copy — keep it verbatim when recreating the composer. The answer box sits on `--bg-inset` because it lives inside an already-carded question.
