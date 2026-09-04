Cost is a first-class citizen in Foreman — this meter appears in every project header and on every running fleet card.

```jsx
<BudgetMeter spent={run.costUsd} budget={run.budgetUsd} />
```

- Thresholds are fixed: gold under 70%, `--status-warning` with a triangle-alert icon from 70%, `--status-critical` with an octagon-alert icon from 90%.
- Figures use tabular numerals so the header does not jitter as cost ticks up.
- Dollar amounts throughout Foreman are notional API-rate costs; copy calls them "cost", never "spend" or "usage".
