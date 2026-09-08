The planning rail's **Schedules** block — the project's standing instructions, above the folder. A schedule starts an ordinary mission on a cadence with nobody watching, so this panel answers one question per row: is it still doing its job?

Header: `Schedules`, a **New** button, and one line of money under it — `$4.20 of $25 this month` — the scheduled spend against the ceiling that pauses schedules. At the ceiling the line says so; with no ceiling set it reads `$4.20 this month · no ceiling set` rather than inventing a `$0` one.

One row per schedule, top to bottom at rail width: name (brief as its tooltip) with a `paused` chip when it is paused; then `daily 07:30 · in 3 h · $6 a run` — a cron cadence prints its expression in the mono family (`cron 0 9 * * 1`), the same way the sheet's input sets it, because proportional asterisks cannot be counted; then, when paused, the reason as a plain sentence (`paused — two runs in a row failed`, `paused — this month's scheduled spend would pass the ceiling`, `paused by you`) — the muted surface and the chip are second signals, never the only one; then `last: done` linking to that run (`#/p/<projectId>/r/<runId>`); then the controls: Pause/Resume, Run now, Edit, Delete. All four are real buttons with consequence-stating titles, and they wrap rather than shrink so no tap target is smaller than its neighbours.

**Resume lives here and only here.** A schedule that paused itself is restarted by a human who has read the reason.

Every action reports the server's own words on the row — a Run now refused because a mission is already running in this project is that sentence, not a swallowed 409. Delete asks first through `ConfirmDialog`.

States: an error line when the list could not be read; "Reading the schedules…" on first load; and an `Empty` that says what a schedule is and when it pauses itself.

Boundary (a stated non-goal): the panel never edits — the sheet (`ScheduleSheet`) does — and it never fetches; it takes data and async callbacks.
