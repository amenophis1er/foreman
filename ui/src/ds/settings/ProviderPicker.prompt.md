Edits one project's `ProviderRef` — which engine drives its agents, who pays,
where requests go. Lives in Settings → Projects, project scope only; a
provider is per-project, so it never appears in global scope.

```jsx
<ProviderPicker value={project.provider ?? null} onChange={(v) => setProvider(v)}
  instances={instancesFromApi} ollama={ollamaFromApi} />
```

- Segmented kind switch first — Server default · Claude Code · Anthropic API ·
  Codex · Custom endpoint — then only the fields that kind takes. Changing the
  tab always replaces the value with a blank one for that kind; it never
  carries a field over from the last kind. That is the one behaviour this
  component exists to get right — see provider-model.md §1. A picker that let
  "own login" survive a switch to Custom endpoint would let you configure a
  subscription token sent to someone else's server, which is the exact leak
  the discriminated union was built to make unrepresentable.
- The keyless kinds are the ones that work today, so they get one-click
  choices instead of a blank form: `instances` lists discovered Claude Code
  installs, `ollama` (when a daemon answers) is a single button that fills in
  its host and lists its pulled models in a select. Both are optional — absent
  them and the kind still works, just as free text.
- A keyed kind (`anthropic-api`, or `openai-compatible` with `apiKeyEnv` set)
  never shows a password field. It collects an environment variable *name*
  and says so in plain text under the field — there is no secret store yet, so
  implying a pasted key would go anywhere would be a lie in exactly the place
  Foreman promises not to tell one (see `BillingBadge`'s house rule).
- "Own login" only exists under Claude Code, and only there — it is what
  makes per-project subscription accounts work, and it is meaningless (worse,
  dangerous) anywhere a gateway is in the wire.
- Advanced fields (executable, a non-default Codex upstream) start collapsed
  behind a text link, not a switch — they exist for the rare case, and a
  settings row that shows every field up front reads as more decisions than
  most projects need to make.
