import React, { useState } from 'react';
import { Icon } from './Icon';

/** Square icon-only control: theme toggle, collapse, close. Always has a `label`. */
export function IconButton({ icon, label, onClick, active, size = 'md', disabled, style }) {
  const [hover, setHover] = useState(false);
  const px = size === 'sm' ? 26 : 32;
  return (
    <button
      type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: px, height: px, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, borderRadius: 'var(--r-sm)', cursor: disabled ? 'default' : 'pointer',
        background: active ? 'var(--bg-card)' : hover ? 'var(--bg-hover)' : 'transparent',
        border: `1px solid ${active ? 'var(--line-strong)' : 'transparent'}`,
        color: active || hover ? 'var(--ink-0)' : 'var(--ink-1)', opacity: disabled ? 0.5 : 1,
        transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)', ...style,
      }}
    ><Icon name={icon} size={size === 'sm' ? 14 : 16} /></button>
  );
}
