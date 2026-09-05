A modal over the whole app that shows one deck artifact in place. Clicking a screenshot or a work file in the Deck used to open a new tab — or download, for anything the browser would not render — which is a detour for a person who wants one look.

Structure: a dark backdrop (click closes, Escape closes) around a card up to 1200×900. The card's header is one row: kind icon, the path in mono (clipped, full in the tooltip), the size, "Open in a new tab" (ghost button — the raw file is still one click away), and a close icon button. The body fills the rest and scrolls.

By kind: `image` fits the body with `object-fit: contain` on an inset ground · `text` is fetched and shown as a wrapped mono `<pre>` (Markdown files render through RichText in a 72ch column) · `pdf` frames the browser's viewer · anything else says "No preview for this kind of file" and offers the download. Text is capped at 512 KB with a line saying so.

Never renders artifact HTML as a document — the server serves it as plain text for that reason, and the viewer shows it as text.

When given `index`, `count` and `onStep`, the header carries ‹ n / N › and the left/right arrow keys step through the list without closing; the ends disable rather than wrap. The Deck passes its artifacts in display order — screenshots first, then work files.

HTML artifacts get two views, switched in the header: **Rendered** frames the file from the preview route in an `<iframe sandbox="allow-scripts">` (the server also sends a CSP `sandbox`, so the page has an opaque origin and cannot reach Foreman's cookies, storage or DOM; its own CSS, scripts and JSON load by relative path); **Source** is the mono text view. Rendered is the default.
