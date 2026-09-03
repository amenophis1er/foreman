Wraps any control with its inline left-hand label; this is the only labelling pattern in Foreman.

```jsx
<Field label="Budget $"><TextInput type="number" min={1} value={budget} onChange={setBudget} width={70} /></Field>
<Field label="Workers" hint="Model for workers (implementation). Pick sonnet or haiku to cut cost.">
  <ModelSelect value={workerModel} onChange={setWorkerModel} />
</Field>
```

Labels are sentence case with no colon. Explanatory copy goes in `hint` (a native tooltip), never as a line under the field.
