Every boxed thing in Foreman — transcript entries, approval and question cards, run detail — is a Card.

```jsx
<Card accent="var(--brand)">Director asks: …</Card>
<Card accent={agentColor('worker-1')} style={{ padding: 'var(--sp-2) var(--sp-3)' }}>…</Card>
<Card tone="inset"><pre>{JSON.stringify(input, null, 2)}</pre></Card>
```

- The left accent stripe is the system's whole mechanism for "who said this" (director gold / worker violet) and "this went wrong" (critical red). Never use it decoratively.
- Cards do not have shadows. Depth comes from the four surface planes plus the hairline.
- Only project cards on the fleet use `--r-md`; card radius here is `--r-sm`.
