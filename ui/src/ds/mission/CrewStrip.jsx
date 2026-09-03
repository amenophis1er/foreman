import React from 'react';
import { AgentDot } from '../status/AgentDot';
import { Icon } from '../core/Icon';

/** Horizontal crew chips for the medium layout, where the left rail is collapsed. */
export function CrewStrip({ agents = [], filter, onFilter, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginRight: 2 }}><Icon name="crew" size={12} />Crew</span>
      {agents.map((a) => {
        const sel = filter === a.id;
        return (
          <button key={a.id} type="button" onClick={() => onFilter?.(a.id)} title={a.task || a.id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 6px', borderRadius: 'var(--r-pill)',
            background: sel ? 'var(--bg-card)' : 'var(--bg-inset)', border: `1px solid ${sel ? 'var(--line-strong)' : 'var(--line)'}`,
            color: sel ? 'var(--ink-0)' : 'var(--ink-1)', fontSize: 'var(--fs-xs)', cursor: 'pointer', font: 'inherit', lineHeight: '16px',
          }}>
            <AgentDot agent={a.id} size="sm" />{a.id}
            <Icon name={a.status || 'running'} size={11} strokeWidth={2.25}
              color={a.status === 'error' ? 'var(--status-critical)' : a.status === 'interrupted' ? 'var(--status-serious)' : a.status === 'idle' ? 'var(--ink-2)' : 'var(--status-good)'} />
          </button>
        );
      })}
    </div>
  );
}
