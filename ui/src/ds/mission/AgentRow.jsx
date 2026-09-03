import React, { useState } from 'react';
import { AgentDot } from '../status/AgentDot';
import { StatusBadge } from '../status/StatusBadge';

/** A row in the crew list. Workers are indented under the director with a tree line. */
export function AgentRow({ agent, status = 'running', task, selected, indent, last, onSelect, style }) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ position: 'relative', marginLeft: indent ? 14 : 0 }}>
      {indent && (
        <span aria-hidden style={{ position: 'absolute', left: -8, top: 0, bottom: last ? '50%' : 0, borderLeft: '1px solid var(--line-strong)' }} />
      )}
      {indent && (
        <span aria-hidden style={{ position: 'absolute', left: -8, top: '50%', width: 8, borderTop: '1px solid var(--line-strong)' }} />
      )}
      <div
        role="button"
        title={task}
        onClick={() => onSelect?.(agent)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
          padding: '6px 8px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
          background: selected ? 'var(--bg-card)' : hover ? 'var(--bg-hover)' : 'transparent',
          border: selected ? '1px solid var(--line-strong)' : '1px solid transparent',
          transition: 'background var(--dur-fast) var(--ease)',
          ...style,
        }}
      >
        <AgentDot agent={agent} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-md)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent}</span>
        <StatusBadge status={status} />
      </div>
    </div>
  );
}
