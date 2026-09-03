import React from 'react';
import { Icon } from '../core/Icon';

export const STATUS_META = {
  idle: { color: 'var(--ink-2)', icon: 'idle', label: 'idle' },
  running: { color: 'var(--status-good)', icon: 'running', label: 'running' },
  done: { color: 'var(--status-good)', icon: 'done', label: 'done' },
  error: { color: 'var(--status-critical)', icon: 'error', label: 'error' },
  interrupted: { color: 'var(--status-serious)', icon: 'interrupted', label: 'interrupted' },
};

/** Status pill — icon carries the color, label carries the meaning. Never color alone. */
export function StatusBadge({ status, style }) {
  const m = STATUS_META[status] ?? STATUS_META.idle;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
      padding: '2px 8px 2px 6px', borderRadius: 'var(--r-pill)',
      background: 'var(--bg-inset)', border: '1px solid var(--line)',
      whiteSpace: 'nowrap', lineHeight: '16px', ...style,
    }}>
      <Icon name={m.icon} size={12} strokeWidth={2.25} color={m.color} />
      {m.label}
    </span>
  );
}
