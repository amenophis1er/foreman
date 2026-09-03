import React from 'react';
import { SectionTitle } from '../core/SectionTitle';
import { Empty } from '../core/Empty';
import { RunRow } from './RunRow';
import { AgentRow } from './AgentRow';

/**
 * The left rail, restructured (debt item 1): the selected run sits on top with its crew nested under it,
 * then "Mission history" lists the other runs. Crew is visibly a property of a run, not a sibling section.
 */
export function RunRail({ current, agents = [], history = [], selectedRunId, filter, onFilter, onSelectRun, sessionId }) {
  const director = agents.find((a) => a.id === 'director');
  const workers = agents.filter((a) => a.id !== 'director');
  const others = history.filter((r) => r.id !== selectedRunId);
  return (
    <>
      <section>
        <SectionTitle>{current?.live ? 'This run' : 'Selected run'}</SectionTitle>
        {current ? (
          <RunRow mission={current.mission} createdAt={current.createdAt} costUsd={current.costUsd} status={current.status} selected current />
        ) : <Empty>No run selected.</Empty>}
        {current && (
          <div style={{ marginLeft: 10, marginTop: 4, paddingLeft: 8, borderLeft: '1px solid var(--line-strong)' }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', margin: '2px 0 4px', textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)' }}>Crew</div>
            {agents.length === 0 && <Empty>No agents yet.</Empty>}
            {director && <AgentRow agent="director" status={director.status} selected={filter === 'director'} onSelect={onFilter} />}
            {workers.map((w, i) => (
              <AgentRow key={w.id} agent={w.id} status={w.status} task={w.task} indent last={i === workers.length - 1}
                selected={filter === w.id} onSelect={onFilter} />
            ))}
            {filter && (
              <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
                Showing only <b style={{ color: 'var(--ink-1)' }}>{filter}</b> — click again to clear.
              </div>
            )}
            {sessionId && (
              <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
                director session {String(sessionId).slice(0, 8)}
              </div>
            )}
          </div>
        )}
      </section>
      <section style={{ marginTop: 'var(--sp-4)' }}>
        <SectionTitle>Mission history</SectionTitle>
        {others.length === 0 && <Empty>No other runs yet.</Empty>}
        {others.map((r) => (
          <RunRow key={r.id} mission={r.mission} createdAt={r.createdAt} costUsd={r.costUsd} status={r.status} onSelect={() => onSelectRun?.(r.id)} />
        ))}
      </section>
    </>
  );
}
