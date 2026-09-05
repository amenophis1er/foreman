The Telegram section under Settings → Notifications, global scope only. Renders below the three notification toggles, which double as the channel's filter — there is deliberately no second set.

```jsx
const notify = useNotify();          // state.ts: status + actions, polls while linking
<NotifyPanel {...notify} />
```

- **Token is write-only end to end.** The field is a password input; once saved the panel shows the bot's `@username` with Replace / Remove and never the token. Same rule as a provider key: the API says whether one exists, never what it is.
- **Linking is a one-time code, not OAuth.** `Link a chat` shows `/start ABC234`; the human sends it to their own bot from the chat that should receive messages; the server long-polls for it and stores that chat id. The panel polls status every few seconds while `linking` is set, shows `waiting…`, and offers `New code`. The code expires in 10 minutes.
- **Only the linked chat is ever written to.** `Send test` proves the path end to end; `Unlink` forgets the chat but keeps the token.
- **Foreman URL** is where deep links in messages point. A phone cannot open `localhost`; the hint says so and suggests a LAN or Tailscale address.
- Status line at the top: `linked · @name · 12 sent · 1 failed`. Failures are counted, never surfaced as errors in a run — a dead channel is a lost tap on the shoulder, not a failed mission.
- Messages themselves are shaped server-side in `src/notify.ts`: one-line summary, project and run name, the unattended deadline, a deep link. Never secrets, never transcript bodies.
