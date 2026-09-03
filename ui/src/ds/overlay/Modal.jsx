import React from 'react';

/** Scrim + centred panel. Backdrop click closes; Foreman has no other overlay type. */
export function Modal({ width = 480, children, onClose, dismissible = true, style }) {
  return (
    <div
      onClick={(e) => { if (dismissible && e.target === e.currentTarget) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-panel)', border: '1px solid var(--line-strong)',
        borderRadius: 'var(--r-md)', overflow: 'hidden', ...style,
      }}>{children}</div>
    </div>
  );
}

/** Modal header strip — mono gold path, or a bold title with a muted explainer under it. */
export function ModalHeader({ children, style }) {
  return (
    <div style={{
      padding: 'var(--sp-3)', borderBottom: '1px solid var(--line)',
      wordBreak: 'break-all', ...style,
    }}>{children}</div>
  );
}

/** Modal footer strip — actions right-aligned, secondary actions on the left. */
export function ModalFooter({ children, style }) {
  return (
    <div style={{
      display: 'flex', gap: 'var(--sp-2)', alignItems: 'center',
      padding: 'var(--sp-3)', borderTop: '1px solid var(--line)', ...style,
    }}>{children}</div>
  );
}
