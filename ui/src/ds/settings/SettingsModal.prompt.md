One settings surface for the whole app. Opened from the gear in the header; from a project it also carries that project's overrides.

```jsx
<SettingsModal global={settings} project={proj.overrides} projectName="fleet-alpha"
  onSave={({ global, project }) => api.saveSettings(global, project)} onClose={close} onUnlink={unlink} />
```

- Header: title · `Global | <project>` scope switch · close. The scope switch is the only place scope changes; it is not repeated per row.
- Left sidebar, seven sections in fixed order: **Provider** · Models · Budget · Approvals · Appearance · Notifications · Projects. A gold dot on a section means the project overrides something in it.
- Rows are `label + hint | control`, hairline-separated. In project scope each row is tagged `global` (inherits) or `override` with a `reset to global` link. Never show a diff or the global value inline — the tag is enough.
- Tool policy is a per-tool `Allow | Ask | Deny` switch. Writes outside the project folder always ask regardless; the hint says so.
- Projects root and hidden-folder toggle are global only; Unlink is project only and the one `danger` button in the modal.
- Provider is project scope only — a `ProviderPicker` row, not a config-dir text field. It carries its own dirty check and rides through `onSave`'s `provider` field, because it saves through `PATCH /projects/:id`, not `PUT /settings` like every other row here. The gold dot on Projects lights for either kind of change.
- Save is `primary`, disabled until something changed; the footer says `Unsaved changes` in warning colour when it is enabled. Only Cancel, the header ×, or Save close the modal — backdrop clicks are ignored so a stray click cannot throw away edits.

- **Provider leads the sidebar** because it decides what every other section can offer — the model list is scoped to it, and it names who pays. It lived under Projects first, where nobody found it.
- In global scope Provider cannot be set (it is per-project) so it lists what the machine can serve instead: discovered Claude Code installs, a running Ollama, a Codex install. An empty panel there reads as broken; this turns a dead end into the answer to "what are my options".

Models has a third row, **Planner**: the model of the planning conversation (default Sonnet), per project like the others.

Opened from a project screen the modal starts on the project scope and lists the project tab first, Global second: the project is what the person came to change, Global is the way up.
