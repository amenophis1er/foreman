The short-value input: budget caps, new-folder names. Always inside a `Field`.

```jsx
<Field label="Budget $"><TextInput type="number" min={1} value={budget} onChange={setBudget} width={70} /></Field>
<TextInput autoFocus placeholder="New folder name" value={name} onChange={setName} onKeyDown={(e) => e.key === 'Enter' && create()} />
```

Enter submits wherever the input stands alone in a row. Validation errors appear as an inline `Banner tone="error"` line in `--status-critical`, not as a red border.
