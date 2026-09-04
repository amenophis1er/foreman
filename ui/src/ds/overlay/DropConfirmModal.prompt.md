The two halves of drop-to-link: the overlay you see while dragging, and the modal that resolves the path.

```jsx
{dragging && <DropOverlay />}
{drop && <DropConfirmModal name={drop.name} matches={drop.matches} onPick={link} onClose={close} />}
```

- `DropOverlay` insets 8px from the fleet view, 2px gold dashed on a 6% gold wash, and is pointer-events-none.
- Three body states: searching, candidate list (mono paths), no match. Each is one muted sentence or a list — nothing more.
- The modal explains *why* it has to ask; Foreman states the constraint rather than hiding it.
