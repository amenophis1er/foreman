The Files tab of the mission rail — the deck at rail width. It replaces the old full-width Deck tab: the rail **lists**, the viewer **shows**.

Structure, top to bottom: one small summary line (`8 changed · +1027 −0 · 21 artifacts · against 3f810ffe`), then **Changed files** as plain rows (file icon, path with the directory clipping and the file name never clipping, status chip, +/−), then **Artifacts**: screenshot thumbnails in a tight 88px grid, then work files as rows with their size. No inline diff, no expanding rows — a click on any row or thumbnail opens `ArtifactViewer`, which gets one ordered list (changed files, screenshots, work files) so the arrow keys walk the whole deck.

States: an error line when the working tree could not be read; "No file record for this run" when the server has no baseline; "Reading the working tree…" while loading. A deleted file is struck through and muted. A `preexisting` file says so in its tooltip.

Boundary (DESIGN.md §11): diff and artifacts, never a file manager or an editor.
