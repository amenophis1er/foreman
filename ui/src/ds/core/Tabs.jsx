import React, { useState } from 'react';
import { Icon } from './Icon';

/** Segmented tabs: a single-row switch between views. Used for narrow layouts and Transcript / Timeline. */
export function Tabs({ tabs, value, onChange, size = 'md', style }) {
  return (
    <div role="tablist" style={{
      display: 'inline-flex', gap: 2, padding: 2, background: 'var(--bg-inset)',
      border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', ...style,
    }}>
      {tabs.map((t) => <Tab key={t.value} tab={t} selected={t.value === value} size={size} onSelect={() => onChange?.(t.value)} />)}
    </div>
  );
}

function Tab({ tab, selected, size, onSelect }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" role="tab" aria-selected={selected} onClick={onSelect}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: size === 'sm' ? '3px 8px' : '5px 10px',
        borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: size === 'sm' ? 'var(--fs-xs)' : 'var(--fs-sm)',
        fontWeight: selected ? 'var(--fw-semibold)' : 'var(--fw-regular)',
        background: selected ? 'var(--bg-card)' : hover ? 'var(--bg-hover)' : 'transparent',
        color: selected ? 'var(--ink-0)' : 'var(--ink-1)', whiteSpace: 'nowrap',
        boxShadow: selected ? 'inset 0 0 0 1px var(--line-strong)' : 'none',
        transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
      }}>
      {tab.icon && <Icon name={tab.icon} size={size === 'sm' ? 12 : 14} />}
      {tab.label}
      {tab.count > 0 && (
        <span style={{
          fontSize: 'var(--fs-xs)', padding: '0 5px', borderRadius: 'var(--r-pill)', lineHeight: '16px',
          background: tab.attention ? 'var(--status-warning)' : 'var(--line-strong)',
          color: tab.attention ? 'var(--brand-ink)' : 'var(--ink-0)', fontWeight: 'var(--fw-semibold)',
        }}>{tab.count}</span>
      )}
    </button>
  );
}
