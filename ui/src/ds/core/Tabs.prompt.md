Switches between views of the same run. Below 900px it replaces the three-column grid; above it, it toggles Transcript / Timeline.

```jsx
<Tabs value={view} onChange={setView} tabs={[
  { value: 'crew', label: 'Crew', icon: 'crew' },
  { value: 'transcript', label: 'Transcript', icon: 'transcript' },
  { value: 'needs', label: 'Needs you', icon: 'needsYou', count: 2, attention: true },
]} />
```

Two to four tabs, short labels. A warning-colored count is the narrow layout's replacement for the attention bar.
