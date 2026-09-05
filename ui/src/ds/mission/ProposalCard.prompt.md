The handoff from planning to work. Rendered under the planning transcript when the planner has proposed a mission.

```jsx
{chat.proposal && (
  <ProposalCard {...chat.proposal} busy={starting} error={err}
    models={models} modelsLoading={modelsLoading} modelsNote={modelsNote} modelsInheritNote={modelsInheritNote}
    onStart={(v) => startMission(v)}   // same shape the Composer submits
    onDismiss={chat.dismissProposal} />
)}
```

- Brand border — the only card in Foreman that wears one. This is the point where reading becomes writing, and it should not look like another transcript row.
- Brief and budget are editable in place. To change the shape of the work, tell the planner and let it redraft.
- **Below the criteria sits the Composer's row, in the Composer's order: Budget cap · Director · Workers · Browser.** The two ways of starting a mission must never disagree about what can be chosen. Models default to inherit (the project's Settings), like the Composer.
- **`browser` comes from the planner.** It sets `browser: true` on the proposal when a DONE WHEN criterion needs a page to load, render, be console-clean or be screenshotted, and the switch starts on with a hint saying why. A mission that needed a browser once started without one and failed its own criteria an hour later. The human can still flip it.
- `onStart` receives the full `ProposalStart` — brief, budget, both models with their provider ids, and `browserTools` — not just brief and budget.
- `Done when` renders as unticked boxes: it is what the director will be held to, not a list of things already true.
- Two actions only: `Not this one` (ghost, local dismiss) and `Start mission` (primary). Nothing on this card ever starts work by itself.
