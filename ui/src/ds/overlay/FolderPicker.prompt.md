Opened by the Link-a-project tile. Presents the filesystem as it is: absolute paths, mono, no favourites or breadcrumbs.

```jsx
<FolderPicker path={cur.path} parent={cur.parent} dirs={cur.dirs}
  onNavigate={load} onCreate={mkdir} onPick={link} onClose={close} />
```

- The current path is the header, in brand gold mono, wrapping on long paths.
- Rows are `..` (CornerLeftUp) and folder-icon rows. Two icons, nothing else.
- `New folder` (Plus icon) toggles an inline name field with Enter-to-submit; errors appear as an inline error Banner above the footer.
- Footer order: New folder · (spacer) · Cancel · Select this folder (primary).
