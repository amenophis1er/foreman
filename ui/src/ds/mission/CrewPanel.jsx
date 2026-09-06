import React from 'react';
import { SectionTitle } from '../core/SectionTitle';
import { Empty } from '../core/Empty';
import { AgentRow } from './AgentRow';

/**
 * Crew and run facts, stacked for the rail. Who is on the run and what each
 * last said about where it is, then the run's own properties. Status, not a
 * surface: it sits under the checklist so it is read in a glance while the
 * transcript stays in view.
 */
export function CrewPanel({ agents = [], filter, onFilter, sessionId, details, style }) {
  const director = agents.find((a) => a.id === 'director');
  const workers = agents.filter((a) => a.id !== 'director');
  const lineStyle = {
    margin: '0 0 6px 0', fontSize: 'var(--fs-xs)', color: 'var(--ink-1)',
    lineHeight: 'var(--lh)', overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', ...style }}>
      <section style={{ minWidth: 0 }}>
        <SectionTitle>Crew</SectionTitle>
        {agents.length === 0 && <Empty>No agents yet.</Empty>}
        {director && (
          <AgentRow agent="director" status={director.status} selected={filter === 'director'} onSelect={onFilter} />
        )}
        {workers.map((w, i) => (
          <React.Fragment key={w.id}>
            <AgentRow agent={w.id} status={w.status} task={w.task} indent last={i === workers.length - 1}
              selected={filter === w.id} onSelect={onFilter} />
            {w.task && (
              // The worker's own account of where it is (its latest
              // report_progress), or the brief's first line before it has said
              // anything. Readable without hovering; the row's tooltip has it too.
              <div title={w.task} style={{ ...lineStyle, marginLeft: 34 }}>{w.task}</div>
            )}
          </React.Fragment>
        ))}
        {filter && (
          <div style={{ marginTop: 4, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            Transcript shows only <b style={{ color: 'var(--ink-1)' }}>{filter}</b> — click again to clear.
          </div>
        )}
      </section>
      <section style={{ minWidth: 0 }}>
        <SectionTitle>Run</SectionTitle>
        {details ?? <Empty>No run details.</Empty>}
        {sessionId && (
          <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
            director session {String(sessionId).slice(0, 8)}
          </div>
        )}
      </section>
    </div>
  );
}
