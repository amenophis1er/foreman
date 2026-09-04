import React from 'react';
import { AgentDot, agentColor } from '../status/AgentDot';

function fmt(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour12: false }); }

/** Compact swimlane timeline of a run: one lane per agent, activity span + event ticks, optional live edge.
 *  With `onTick`, each tick is a click target (with a widened invisible hitbox) for jumping to that entry. */
export function RunTimeline({ agents = [], entries = [], live, selected, onSelect, onTick, height = 22, style }) {
  if (!entries.length) return null;
  const t0 = Math.min(...entries.map((e) => e.ts));
  const last = Math.max(...entries.map((e) => e.ts));
  const t1 = live ? Math.min(Math.max(Date.now(), last), last + 60_000) : last;
  const span = Math.max(t1 - t0, 1000);
  const x = (t) => `${((t - t0) / span) * 100}%`;
  const ids = agents.length ? agents.map((a) => a.id ?? a) : [...new Set(entries.map((e) => e.agent))];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', rowGap: 4, columnGap: 10, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', ...style }}>
      {ids.map((id) => {
        const mine = entries.filter((e) => e.agent === id);
        if (!mine.length) return null;
        const a0 = Math.min(...mine.map((e) => e.ts));
        const st = agents.find((a) => (a.id ?? a) === id)?.status;
        const a1 = st === 'running' && live ? t1 : Math.max(...mine.map((e) => e.ts));
        const dim = selected && selected !== id;
        return (
          <React.Fragment key={id}>
            <button type="button" onClick={() => onSelect?.(id)} title={`Filter transcript to ${id}`} style={{
              display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0,
              cursor: onSelect ? 'pointer' : 'default', color: dim ? 'var(--ink-2)' : 'var(--ink-1)', font: 'inherit', textAlign: 'left',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}><AgentDot agent={id} size="sm" />{id}</button>
            <div style={{ position: 'relative', height, background: 'var(--bg-inset)', borderRadius: 4, opacity: dim ? 0.45 : 1 }}>
              <div style={{
                position: 'absolute', left: x(a0), width: `calc(${x(a1)} - ${x(a0)})`, top: 6, bottom: 6, minWidth: 3,
                background: agentColor(id), opacity: 0.15, borderRadius: 3,
              }} />
              {mine.map((e) => {
                const tick = (
                  <span style={{
                    display: 'block', width: e.kind === 'text' ? 3 : 2,
                    height: e.kind === 'text' ? height - 6 : height - 14, borderRadius: 1,
                    background: e.kind === 'error' ? 'var(--status-critical)' : e.kind === 'tool' ? 'var(--ink-0)' : agentColor(id),
                    boxShadow: '0 0 0 1px var(--bg-inset)',
                  }} />
                );
                const label = `${fmt(e.ts)} · ${e.title || e.kind}`;
                return onTick ? (
                  <button key={e.id ?? e.ts} type="button" title={label} aria-label={`Jump to ${label}`}
                    onClick={() => onTick(e)} style={{
                      position: 'absolute', left: x(e.ts), top: 0, bottom: 0, width: 9, marginLeft: -4,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    }}>{tick}</button>
                ) : (
                  <span key={e.id ?? e.ts} title={label} style={{
                    position: 'absolute', left: x(e.ts), top: e.kind === 'text' ? 3 : 7, marginLeft: -1,
                  }}>{tick}</span>
                );
              })}
              {live && st === 'running' && <span className="pulse" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 2, background: 'var(--status-good)' }} />}
            </div>
          </React.Fragment>
        );
      })}
      <span />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontVariantNumeric: 'tabular-nums' }}>
        <span>{fmt(t0)}</span><span>{live ? 'now' : fmt(t1)}</span>
      </div>
    </div>
  );
}
