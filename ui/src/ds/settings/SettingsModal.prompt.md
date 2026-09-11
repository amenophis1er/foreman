One settings surface for the whole app. Opened from the gear in the header; from a project it also carries that project's overrides.

```jsx
<SettingsModal global={settings} project={proj.overrides} projectName="fleet-alpha"
  onSave={({ global, project }) => api.saveSettings(global, project)} onClose={close} onUnlink={unlink} />
```

- Header: title · `Global | <project>` scope switch · close. The scope switch is the only place scope changes; it is not repeated per row.
- Left sidebar, eight sections in fixed order: **Provider** · Models · Crew · Budget · Approvals · Appearance · Notifications · Projects. A gold dot on a section means the project overrides something in it.
- Rows are `label + hint | control`, hairline-separated. In project scope each row is tagged `global` (inherits) or `override` with a `reset to global` link. Never show a diff or the global value inline — the tag is enough.
- Tool policy is a per-tool `Allow | Ask | Deny` switch. Writes outside the project folder always ask regardless; the hint says so.
- Projects root and hidden-folder toggle are global only; Unlink is project only and the one `danger` button in the modal.
- Projects also holds **Isolation** (`Shared checkout` | `A worktree per mission`) and **Missions at once** (1–5). They read as one decision: a shared checkout is one folder, so it is always one mission; a worktree project gives each mission its own checkout under Foreman's home and can run several. Worktrees need the ROOT of a git repository — with `projectIsRepo={false}`, or with `projectGitRoot` naming a folder above `projectFolder`, the choice is shown greyed with the reason, not hidden, and the number row is greyed at 1 whenever isolation is `shared`. The server refuses both cases as well; this is the friendly half. The number row displays 1 for a shared checkout but keeps its own value, which defaults to 2 — the server's worktree default — so that switching a project to worktrees and saving does not silently pin it to one mission.
- Provider is project scope only — a `ProviderPicker` row, not a config-dir text field. It carries its own dirty check and rides through `onSave`'s `provider` field, because it saves through `PATCH /projects/:id`, not `PUT /settings` like every other row here. The gold dot on Projects lights for either kind of change.
- Save is `primary`, disabled until something changed; the footer says `Unsaved changes` in warning colour when it is enabled, and `Not saved — <reason>` in critical colour when the caller passes `saveError` because the server refused the last save; the modal stays open with the edits intact. Only Cancel, the header ×, or Save close the modal — backdrop clicks are ignored so a stray click cannot throw away edits.

- **Provider leads the sidebar** because it decides what every other section can offer — the model list is scoped to it, and it names who pays. It lived under Projects first, where nobody found it.
- In global scope Provider cannot be set (it is per-project) so it lists what the machine can serve instead: discovered Claude Code installs, a running Ollama, a Codex install. An empty panel there reads as broken; this turns a dead end into the answer to "what are my options".

Crew is the `crewPresets` list: the named roles the composer can add to a mission. One `Presets` row holds all of it, so the whole list is one overridable value — a project's list replaces global's, it never merges. Each preset collapses to `name · kind · model · required`, expands in place to name, kind, model (`ModelSelect`, which also sets `providerId`), brief, tools and — reviewers only — a `required for done` switch. An expanded preset is taller than the modal body, so its collapsed-summary row sticks to the top of the section's scroll area while it is open: you never edit a brief with nothing on screen saying whose it is. The brief box does not show a resize grabber — it would be the one native-styled control in the modal. Ids are generated from the name with a random suffix and never shown as a field: they are what a mission stores. Until anything is saved the list is the two built-ins, `Reviewer` (required) and `Security review`; the first edit writes the whole list, so what was on screen is what is stored.

Models has a third row, **Planner**: the model of the planning conversation (default Sonnet), per project like the others.

Opened from a project screen the modal starts on the project scope and lists the project tab first, Global second: the project is what the person came to change, Global is the way up.
