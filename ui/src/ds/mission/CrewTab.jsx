import React from 'react';
import { SectionTitle } from '../core/SectionTitle';
import { Empty } from '../core/Empty';
import { AgentRow } from './AgentRow';

/**
 * The Crew tab: who is on the run, what each of them is doing right now, and
 * the run's own properties. This is the old left rail's content, made a tab
 * rather than a permanent column: the crew is a property of the run you look
 * at when you want it, not a thing that should share the screen with every
 * transcript line.
 */
export function CrewTab({ agents = [], filter, onFilter, sessionId, details, style }) {
  const director = agents.find((a) => a.id === 'director');
  const workers = agents.filter((a) => a.id !== 'director');
  const lineStyle = {
    margin: '0 0 6px 34px', fontSize: 'var(--fs-xs)', color: 'var(--ink-1)',
    lineHeight: 'var(--lh)', overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
  };
  return (
    <div style={{ padding: 'var(--sp-3)', display: 'grid', gap: 'var(--sp-4)', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', ...style }}>
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
              // The worker's own account of where it is (the latest
              // `report_progress`), or the brief's first line before it has
              // said anything. The row's tooltip carries the same text; this
              // makes it readable without hovering.
              <div title={w.task} style={{ ...lineStyle, marginLeft: 48 }}>{w.task}</div>
            )}
          </React.Fragment>
        ))}
        <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
          {filter
            ? <>Transcript shows only <b style={{ color: 'var(--ink-1)' }}>{filter}</b> — click again to clear.</>
            : 'Click an agent to filter the transcript to it.'}
        </div>
      </section>
      <section style={{ minWidth: 0 }}>
        <SectionTitle>Run</SectionTitle>
        {details ?? <Empty>No run details.</Empty>}
        {sessionId && (
          <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
            director session {String(sessionId).slice(0, 8)}
          </div>
        )}
      </section>
    </div>
  );
}
