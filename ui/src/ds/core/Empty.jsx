import React from 'react';

/** Muted one-line empty state. Foreman never draws illustrated empty states. */
export function Empty({ children }) {
  return <div style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>{children}</div>;
}
