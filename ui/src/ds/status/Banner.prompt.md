Persistent conditions and errors. Foreman deliberately has no toast layer — messages stay where the cause is.

```jsx
<Banner tone="readonly">Viewing a past run (read-only).</Banner>
<Banner tone="disconnected" inline>disconnected</Banner>
<Banner tone="error" inline>{err}</Banner>
```

- The read-only strip sits directly under the project header on any historical run and stays put.
- Inline errors are the server's own message, prefixed with the error icon — never rewritten, never dismissed by a timer.
- `disconnected` is pushed to the far right of the fleet header and appears only while the SSE stream is down.
