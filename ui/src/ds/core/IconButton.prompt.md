For actions that are understood from the icon alone and carry no consequence — toggles and dismissals.

```jsx
<IconButton icon={theme === 'dark' ? 'sun' : 'moon'} label="Switch theme" onClick={toggle} />
<IconButton icon="chevronDown" label="Collapse" size="sm" active={open} />
```

Anything that starts, stops, approves, or deletes is a `Button` with a verb.
