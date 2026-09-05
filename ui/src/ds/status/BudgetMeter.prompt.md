Cost is a first-class citizen in Foreman — this meter appears in every project header and on every running fleet card.

```jsx
<BudgetMeter spent={run.costUsd} budget={run.budgetUsd}
  metered={run.metered} usage={run.usage} turns={run.turns} />
```

- Thresholds are fixed: gold under 70%, `--status-warning` with a triangle-alert icon from 70%, `--status-critical` with an octagon-alert icon from 90%.
- Figures use tabular numerals so the header does not jitter as cost ticks up.
- Dollar amounts throughout Foreman are notional API-rate costs; copy calls them "cost", never "spend" or "usage".
- **`metered={false}` renders no dollar figure at all.** A gateway prices local or third-party tokens with Anthropic's table, so `spent` would be fiction — the meter shows tokens (and turns, when given) instead, matching `BillingBadge`'s `local`/`provider` wording in the tooltip.
- In that mode the bar renders as an empty track, not a fabricated fill. The honest fill would be turns-used/60 or elapsed/45min (the server's actual caps), but this component isn't passed those — an empty track beats a fraction backed by a number it doesn't have.
- `usage` is the same `TokenUsage` shape as `RunView`/`RunSummary` in `state.ts`; pass `null` (or omit) when unknown and it renders `0 tok`.
