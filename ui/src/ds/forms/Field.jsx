import React from 'react';

/**
 * Label + control. `layout="inline"` (default): `Budget $ [70]`, hint as tooltip.
 * `layout="stacked"`: small-caps label above, control, hint as a visible caption — the composer's parameter tray.
 */
export function Field({ label, hint, layout = 'inline', children, style }) {
  if (layout === 'stacked') {
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 5, ...style }}>
        <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>{label}</span>
        {children}
        {hint && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{hint}</span>}
      </label>
    );
  }
  return (
    <label title={hint} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      color: 'var(--ink-1)', fontSize: 'var(--fs-sm)', ...style,
    }}>{label}{children}</label>
  );
}
