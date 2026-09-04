Foreman still has no toasts. When the director or a worker is blocked on the human, this bar appears above the transcript and stays until the queue is empty.

```jsx
<AttentionBar approvals={run.approvals.length} questions={run.questions.length} onReview={scrollRailToTop} />
```

- Warning tint on the card surface, 1px warning border, pulsing bell — the same vocabulary as the fleet card's `NeedsYouStrip`, zoomed in.
- One action, `Review`. It never dismisses; resolving the items removes it.
