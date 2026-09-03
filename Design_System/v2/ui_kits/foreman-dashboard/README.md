# Foreman dashboard — UI kit

A click-through recreation of Foreman's only product surface: the browser
dashboard that plans, runs, and audits autonomous missions. Built from the
shipped code in `foreman/ui/src` (App, FleetView, ProjectView, Transcript,
RightPanel, AgentTree, FolderPicker), not from screenshots.

Open `index.html`. Everything is fake data driven by your own clicks.

## The flow it demonstrates

1. **Fleet** — two linked projects (Alpha idle, Beta idle) and the dashed
   `Link a project` tile. Clicking the tile opens the real folder-picker
   modal; dragging any folder onto the page shows the gold drop overlay and
   then the drop-confirm modal with candidate absolute paths.
2. **Project (idle)** — history rail on the left, the mission composer
   centred at 720px: template chips, editor frame (Write / Preview, quote ·
   code · code block, attachments by paperclip / drop / paste), parameter
   tray (budget cap, director, workers), `Start mission` (⌘↵).
   The model pickers load from `FMK.fetchModels` — stands in for `GET /models`,
   which the server does not expose yet (it currently accepts only
   opus/sonnet/haiku in `modelChoice`; fable needs adding there too).
3. **Live run** — the three-column workspace (250 / 1fr / 340). Watch the
   director write `MISSION.md`, then ask you a question in the right rail.
   Answer it and it spawns `worker-1`, which raises a **Write** approval.
   Allow it and the director verifies independently and closes the plan
   3/3. Cost ticks up in the header meter the whole time.
4. **Interrupt / resume** — `Interrupt` at any point puts the run in
   `interrupted` with an error entry; `Resume` restores it (with the disabled `Resuming…` state in between).
5. **Replay** — pick any run in the left rail's `Runs` list to view it
   read-only, under the `Viewing a past run (read-only)` banner. The
   interrupted run in history offers `Resume`.
6. **Transcript filter** — click an agent row to filter the transcript to
   that agent; click again to clear.

## Files

| File | Role |
|---|---|
| `index.html` | Loads tokens, the component bundle, and the screens |
| `data.js` | Fake project, run, plan, folder-tree and history data (`window.FMK`) |
| `FleetScreen.jsx` | Fleet home: grid, link tile, picker, drag-to-link |
| `ComposerScreen.jsx` | Project view with no active run |
| `MissionScreen.jsx` | Project view with a run displayed — live or replayed |
| `app.jsx` | Route + a scripted orchestrator that advances on your actions |

## What is deliberately not here

- Real SSE, HTTP, persistence, or auth — phases advance on click. Drafts and the theme choice do persist (localStorage).
- A real filesystem — the folder picker walks a small fake tree.

## Debt fixes you can try here

- Resize the window: three columns ≥ 1180, two (crew strip) ≥ 900, tabs below.
- Toggle the theme with the sun/moon button in any header.
- Click a template chip in the composer, type, leave, come back — the draft is restored.
- Answer the director's question, then expand the worker's `Edit` approval to see the diff view.
- Scroll the right rail away while something is pending — the attention bar stays above the transcript.
- Click `Unlink` on a fleet card for the confirm dialog.
