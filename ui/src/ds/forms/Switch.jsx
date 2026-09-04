import React, { useState } from 'react';

/** On/off. Brand-filled when on; the knob is `--brand-ink` so it reads on gold. */
export function Switch({ checked = false, onChange, disabled, label, size = 'md', style }) {
  const [hover, setHover] = useState(false);
  const w = size === 'sm' ? 28 : 34, h = size === 'sm' ? 16 : 20, k = h - 4;
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange?.(!checked)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', width: w, height: h, flex: '0 0 auto', padding: 0, borderRadius: 'var(--r-pill)',
        border: `1px solid ${checked ? 'var(--brand)' : hover ? 'var(--ink-2)' : 'var(--line-strong)'}`,
        background: checked ? 'var(--brand)' : 'var(--bg-inset)', cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)', ...style,
      }}>
      <span aria-hidden style={{
        position: 'absolute', top: 1, left: checked ? w - k - 3 : 1, width: k, height: k, borderRadius: 'var(--r-pill)',
        background: checked ? 'var(--brand-ink)' : 'var(--ink-1)',
        transition: 'left var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)',
      }} />
    </button>
  );
}
