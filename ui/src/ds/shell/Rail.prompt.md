The container for the mission workspace's side columns, plus the hook that decides how many of them fit.

```jsx
const tier = LayoutTier.use(rootRef); // from the bundle; `useLayoutTier` when importing the source
// wide:   <main grid 250px 1fr 340px> <Rail left/> <Transcript/> <Rail right/> </main>
// medium: <main grid 1fr 340px> <Transcript with crew strip on top/> <Rail right/> </main>
// narrow: <Tabs crew | transcript | needs you/> then the chosen panel, full width
```

Rails scroll independently; the transcript column owns auto-scroll. Breakpoints are 1180 and 900 (`--bp-medium`, `--bp-narrow`).
