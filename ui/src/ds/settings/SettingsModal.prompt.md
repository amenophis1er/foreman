One settings surface for the whole app. Opened from the gear in the header; from a project it also carries that project's overrides.

```jsx
<SettingsModal global={settings} project={proj.overrides} projectName="fleet-alpha"
  onSave={({ global, project }) => api.saveSettings(global, project)} onClose={close} onUnlink={unlink} />
```

- Header: title · `Global | <project>` scope switch · close. The scope switch is the only place scope changes; it is not repeated per row.
- Left sidebar, six sections in fixed order: Models · Budget · Approvals · Appearance · Notifications · Projects. A gold dot on a section means the project overrides something in it.
- Rows are `label + hint | control`, hairline-separated. In project scope each row is tagged `global` (inherits) or `override` with a `reset to global` link. Never show a diff or the global value inline — the tag is enough.
- Tool policy is a per-tool `Allow | Ask | Deny` switch. Writes outside the project folder always ask regardless; the hint says so.
- Projects root and hidden-folder toggle are global only; Unlink is project only and the one `danger` button in the modal.
- Save is `primary`, disabled until something changed; the footer says `Unsaved changes` in warning colour when it is enabled. Only Cancel, the header ×, or Save close the modal — backdrop clicks are ignored so a stray click cannot throw away edits.
