The planner asked a question with options. This takes the ChatBar's slot at the bottom of the planning transcript and turns the answer into a click.

```jsx
{chat.question
  ? <QuestionPicker questions={chat.question.questions} askedAt={chat.question.askedAt} who={chat.who}
      onAnswer={(a) => chat.answer(chat.question.id, a)} />
  : <ChatBar busy={chat.thinking} who={chat.who} onSend={chat.send} />}
```

- **It replaces the bar; it never sits above it.** Right now the question *is* the input. Two ways to reply to one thing side by side would be a real question about which to use. Typing still works: the free-text line is the bar's textarea, and the server routes anything typed to the waiting question.
- **One single-choice question answers on click.** No confirm step for the common case. Several questions, or a multi-select, show a check per answered question and one `Send answers`.
- **Keyboard:** digits `1`–`9` pick in the focused question, `↑`/`↓` move between questions, `Enter` sends when everything is answered, `⌘↵` sends free text.
- **The first option is the recommended one** — marked `· recommended`, never preselected. A default the human did not click must never be what gets sent.
- Answers are keyed by question text, exactly what the server echoes back to the planner (`formatAnswers` in `src/ask.ts`), and the transcript records the choice as `you chose` in the same `Question → Answer` form. Picker, transcript and model agree on what was decided.
- Shows `waiting Nm` after a minute. If nobody answers for 30 minutes the server times the question out and the planner proceeds on its recommendations, stating the assumptions — the picker disappears and a loud `no answer (unattended)` entry takes its place.
- The `who` line under the picker is the same model · provider the ChatBar footer shows. Server-provided; never derived here.
- Data arrives on the `chat_question` event and leaves on `chat_answered` / `chat_question_timeout`; `GET /chat` returns the still-open question so a reload restores the picker.
