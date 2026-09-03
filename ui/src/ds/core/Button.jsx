import React, { useState } from 'react';
import { Icon } from './Icon';

const VARIANTS = {
  default: { background: 'var(--bg-card)', border: '1px solid var(--line-strong)', color: 'var(--ink-0)' },
  primary: { background: 'var(--brand)', border: '1px solid var(--brand)', color: 'var(--brand-ink)', fontWeight: 'var(--fw-semibold)' },
  good: { background: 'transparent', border: '1px solid var(--status-good)', color: 'var(--ink-0)' },
  danger: { background: 'transparent', border: '1px solid var(--status-critical)', color: 'var(--ink-0)' },
  ghost: { background: 'none', border: '1px solid transparent', color: 'var(--ink-1)' },
};
const HOVER = {
  default: { borderColor: 'var(--ink-2)' },
  primary: { filter: 'brightness(1.08)' },
  good: { background: 'color-mix(in srgb, var(--status-good) 14%, transparent)' },
  danger: { background: 'color-mix(in srgb, var(--status-critical) 14%, transparent)' },
  ghost: { color: 'var(--ink-0)', background: 'var(--bg-hover)' },
};
const ACTIVE = {
  default: { background: 'var(--bg-inset)' },
  primary: { filter: 'brightness(0.94)' },
  good: { background: 'color-mix(in srgb, var(--status-good) 22%, transparent)' },
  danger: { background: 'color-mix(in srgb, var(--status-critical) 22%, transparent)' },
  ghost: { background: 'var(--bg-inset)' },
};
const SIZES = {
  sm: { padding: '3px 8px', fontSize: 'var(--fs-sm)', gap: 5, icon: 13 },
  md: { padding: '6px 12px', fontSize: 'var(--fs-md)', gap: 6, icon: 15 },
};

/** Foreman's only button. Variant carries the intent; text always says the verb. */
export function Button({ children, onClick, variant = 'default', size = 'md', icon, disabled, title, type = 'button', style }) {
  const [hover, setHover] = useState(false);
  const [down, setDown] = useState(false);
  const s = SIZES[size] || SIZES.md;
  return (
    <button
      type={type} title={title} disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setDown(false); }}
      onMouseDown={() => setDown(true)}
      onMouseUp={() => setDown(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: s.gap,
        padding: s.padding, borderRadius: 'var(--r-sm)', fontSize: s.fontSize, lineHeight: 'var(--lh)',
        whiteSpace: 'nowrap', cursor: disabled ? 'default' : 'pointer',
        transition: 'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), filter var(--dur-fast) var(--ease)',
        ...VARIANTS[variant],
        ...(disabled ? { opacity: 0.5 } : hover ? HOVER[variant] : null),
        ...(!disabled && down ? ACTIVE[variant] : null),
        ...style,
      }}
    >{icon && <Icon name={icon} size={s.icon} />}{children}</button>
  );
}
