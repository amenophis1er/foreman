Says which account pays. Appears in the fleet header, the project header, and directly beneath Start mission.

```jsx
<BillingBadge mode="api-key" source="ANTHROPIC_API_KEY" />
<BillingBadge mode="subscription" compact />
```

- Four modes only: `api-key`, `subscription`, `cloud`, `none`. A project billing its own pinned login reads as `subscription`, not as the server's mode.
- Only `api-key` and `none` get a coloured ring. `subscription` and `cloud` stay on the plain `--line` hairline — if every mode were loud, none of them would register.
- Never show it alone as a colour or a glyph; the label is what makes it readable, exactly as with `StatusBadge`.
- `compact` drops the `billing:` prefix for dense rows. Keep the full form in headers.
- The server decides the mode — including per-project billing. Do not derive it in the view from a config path.
- Pass `account` whenever the server knows it. The label then reads as the account email rather than the word `subscription`, because two subscriptions on one machine are indistinguishable otherwise. The org name goes in the tooltip.
