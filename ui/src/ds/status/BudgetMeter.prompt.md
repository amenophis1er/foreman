Cost is a first-class citizen in Foreman — this meter appears in every project header and on every running fleet card.

```jsx
<BudgetMeter spent={run.costUsd} budget={run.budgetUsd}
  costBasis={run.costBasis} usage={run.usage} turns={run.turns} />
```

- Thresholds are fixed: gold under 70%, `--status-warning` with a triangle-alert icon from 70%, `--status-critical` with an octagon-alert icon from 90%.
- Figures use tabular numerals so the header does not jitter as cost ticks up.
- Dollar amounts throughout Foreman are notional API-rate costs; copy calls them "cost", never "spend" or "usage".
- **Only `costBasis="priced"` renders a dollar figure.** A gateway prices local or third-party tokens with Anthropic's table, so `spent` would be fiction — the other two bases show tokens (and turns, when given) instead, matching `BillingBadge`'s `local`/`provider` wording in the tooltip.
- **`free` and `unpriced` must never look the same.** `free` is an empty track: nothing is being spent. `unpriced` is a *striped* track: something is, and no one here can say how much (an OpenAI key with no price table, a `:cloud` model, a subscription allowance). The tooltip carries the words; the track carries the distinction on a fleet card too narrow for words. This replaced a boolean that collapsed both into one rendering and one tooltip that tried to describe both at once.
- Neither renders a fabricated fill. The honest fill would be turns-used/cap or elapsed/cap (the server's actual limits), but this component isn't passed those — no magnitude claim beats a fraction backed by a number it doesn't have.
- `usage` is the same `TokenUsage` shape as `RunView`/`RunSummary` in `state.ts`; pass `null` (or omit) when unknown and it renders `0 tok`.
