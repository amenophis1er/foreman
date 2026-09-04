import React, { useState } from 'react';
import { StatusBadge } from '../status/StatusBadge';

/** A run in the history rail: its name (or mission), date, cost, status. */
export function RunRow({ mission, title, createdAt, costUsd = 0, status = 'done', selected, current, onSelect, style }) {
  const [hover, setHover] = useState(false);
  const cost = Number(costUsd) || 0;
  const date = createdAt
    ? new Date(createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div
      role="button"
      title={mission}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '6px 10px', borderRadius: 'var(--r-sm)', cursor: onSelect ? 'pointer' : 'default',
        background: selected ? 'var(--bg-card)' : hover && onSelect ? 'var(--bg-hover)' : 'transparent',
        border: selected ? '1px solid var(--line-strong)' : '1px solid transparent',
        marginBottom: 2, transition: 'background var(--dur-fast) var(--ease)',
        ...style,
      }}
    >
      <div style={{
        fontSize: 'var(--fs-sm)', overflow: 'hidden', whiteSpace: 'nowrap',
        textOverflow: 'ellipsis', color: 'var(--ink-0)', fontWeight: current ? 'var(--fw-semibold)' : 'var(--fw-regular)',
      }}>{title || mission}</div>
      <div style={{
        display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', marginTop: 2,
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums',
      }}>
        {date && <span>{date}</span>}
        <span>${cost.toFixed(2)}</span>
        <StatusBadge status={status} />
      </div>
    </div>
  );
}
