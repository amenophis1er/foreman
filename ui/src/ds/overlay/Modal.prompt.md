Wraps the two modals in the product (folder picker, drop confirm). Use it for any new one rather than inventing a dialog.

```jsx
<Modal width={520} onClose={close}>
  <ModalHeader><b>alpha</b></ModalHeader>
  <div style={{ overflowY: 'auto', flex: 1 }}>…</div>
  <ModalFooter><Button onClick={close}>Cancel</Button></ModalFooter>
</Modal>
```

- Dismissal is backdrop click plus an explicit `Cancel` in the footer. No corner close button, no Escape-only close.
- The body is the scroll region; header and footer stay fixed.
- Modals never animate in — they are already there when you look.
