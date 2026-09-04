The handoff from planning to work. Rendered under the planning transcript when the planner has proposed a mission.

```jsx
{chat.proposal && (
  <ProposalCard {...chat.proposal} busy={starting} error={err}
    onStart={({ mission, budget }) => start(mission, budget)}
    onDismiss={chat.dismissProposal} />
)}
```

- Brand border — the only card in Foreman that wears one. This is the point where reading becomes writing, and it should not look like another transcript row.
- Brief and budget are editable in place; everything else is a conversation away. To change the shape, tell the planner and let it redraft.
- `Done when` renders as unticked boxes: it is what the director will be held to, not a list of things already true.
- Two actions only: `Not this one` (ghost, local dismiss) and `Start mission` (primary). Nothing on this card ever starts work by itself.
