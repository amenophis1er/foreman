The `Deck` tab of the mission body. Answers one question: what did this run do to the folder.

```jsx
const d = useDeck(run.id, run.runStatus === 'running');
<DeckTab runId={run.id} deck={d.deck} loading={d.loading} error={d.error} missing={d.missing} />
```

- Read-only, permanently — DESIGN.md §11: the deck is diff and artifacts, not a file manager and not an editor, and there is no terminal in the UI. Nothing here mutates the folder; the artifact links open the server's path-jailed `GET /runs/{id}/artifact?path=` in a new tab and that is the whole surface.
- One summary line first: `3 files changed · +214 −38 · 7 artifacts`, then the baseline (`against 9fe4197` for git, the snapshot line otherwise) in muted ink, and the server's `note` in `--status-serious` when it has a caveat.
- **Changed files**: one row per file — mono path, a status chip outlined in `--status-good` (added) / `--status-critical` (deleted) / `--ink-1` (modified, renamed), `+n −m` tabular. `preexisting` adds a quiet "also dirty before the run" tag, because a diff that includes the human's own unstaged edits must say so or the crew gets credit and blame it did not earn. Clicking a row expands the unified diff line by line: `+` on `--diff-add-bg`, `-` on `--diff-del-bg`, hunk and file headers in `--ink-2`, no syntax colouring. `truncated` closes the diff with "first 400 lines".
- **Artifacts**: images as a thumbnail grid (`object-fit: cover`, filename under each); text, pdf and other as rows with size and age. Clicking either opens the file itself.
- Empty states are single lines: "Nothing changed in the folder yet.", "No screenshots or work files produced yet.", and — when the endpoint 404s — "No deck for this run — the server has not recorded a baseline for it."


Clicking any artifact — a screenshot tile or a work-file row — opens it in `ArtifactViewer`, a modal over the app, instead of a new tab. The raw file is still reachable from the viewer's "Open in a new tab".
