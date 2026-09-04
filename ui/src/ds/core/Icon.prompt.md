Every icon in Foreman goes through this one component and its semantic map.

```jsx
<Icon name="running" size={14} color="var(--status-good)" />
<Icon name="Bash" />                      // tool icon in a transcript chip
<Icon name="needsYou" label="Needs you" /> // icon-only: give it a label
```

- Page setup: load `https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js` after React (templates get it from `ds-base.js`). Until it loads, the icon is a blank box of the right size.
- Stroke 1.75, round caps — never mix in filled or two-tone icons.
- Status icons take the status color; everything else inherits the text color.
- No emoji, no Unicode glyphs as icons, anywhere.
