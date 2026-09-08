The editor for a standing instruction — a 640px `Modal` opened by the rail's Schedules panel, for create and for edit.

Top to bottom: **Name** (what it is called in the rail and in the notification), **Brief** (the mission, written as it would be in the composer), then the cadence picker: a `Tabs` segment — Daily / Weekly / Every N hours / Cron — with only the fields that kind needs. Weekly's day is seven small buttons, Mon first. "Every N hours" is hours, minimum one, and maps to `{kind:'interval', everyMinutes: N*60}`; the sheet never offers less than an hour because a mission that starts every few minutes is a runaway. Cron is five fields, mono.

Under the picker, in an inset well, the **next three runs** from `GET /schedules/preview` — debounced 300ms, because a cron expression is typed one character at a time. The server's 400 reason is printed there verbatim: a cadence nobody can read says so here rather than at 3am.

Then **Budget cap** (per run, not per month), and **Director** and **Workers** through `ModelSelect` — the provider id is carried through with the model id, exactly as the composer does.

The footer carries the **Enabled** switch (off keeps the schedule but stops it firing), reading `Enabled` or `Paused` beside it. It lives there rather than at the bottom of the body because the body scrolls: on a short screen the one control that decides whether any of this ever fires would otherwise be off-screen with nothing to say so.

The footer also states the one thing standing in the way of saving (`Give it a name.`, `Time must read as HH:MM, like 07:30.`) and Save is disabled until nothing is. It is disabled too while the preview well is showing the server's refusal of the cadence, with that sentence as its `title` — the preview has already been told the answer a save would get. A preview still in flight disables nothing: a slow answer must not hold up a cadence that is fine. This is a second line only; the server validates again on POST/PUT. The server's error text replaces the footer message and the sheet stays open; on success the sheet closes.

Boundary (a stated non-goal): it does not pause, resume, run or delete — those are the panel's, and resume is deliberately nowhere else.
