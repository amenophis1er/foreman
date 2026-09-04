import React from 'react';
import { Icon } from '../core/Icon';

const TONES = {
  readonly: { icon: 'readonly', color: 'var(--status-warning)' },
  disconnected: { icon: 'disconnected', color: 'var(--status-serious)' },
  error: { icon: 'error', color: 'var(--status-critical)' },
  caution: { icon: 'caution', color: 'var(--status-serious)' },
};

/** Full-width strip under a header (read-only, disconnected) or an inline error line. */
export function Banner({ tone = 'readonly', children, inline, style }) {
  const t = TONES[tone] ?? TONES.readonly;
  if (inline) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: t.color, fontSize: 'var(--fs-sm)', ...style }}>
        <Icon name={t.icon} size={13} strokeWidth={2} />{children}
      </span>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
      padding: 'var(--sp-1) var(--sp-3)', background: 'var(--bg-inset)',
      borderBottom: '1px solid var(--line)', fontSize: 'var(--fs-sm)',
      color: 'var(--ink-1)', ...style,
    }}>
      <Icon name={t.icon} size={14} color={t.color} />
      {children}
    </div>
  );
}
