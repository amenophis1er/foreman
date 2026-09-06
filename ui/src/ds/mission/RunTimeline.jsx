import React from 'react';
import { AgentDot, agentColor } from '../status/AgentDot';

function fmt(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour12: false }); }

/** Steps a person reads without doing arithmetic: 1s … 6h. */
const STEPS = [1, 5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600].map((s) => s * 1000);

/**
 * Gridlines at round wall-clock times across the run — the thing that turns a
 * bar of ticks into a ruler. Aimed at five or six marks: enough to read the
 * pace of the work, few enough not to become a fence.
 */
function ruler(t0, t1) {
  const span = t1 - t0;
  const step = STEPS.find((s) => span / s <= 6) ?? STEPS[STEPS.length - 1];
  const marks = [];
  // Align to the clock, not to the run's start: 04:15:00 reads, 04:13:47 does not.
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) marks.push(t);
  return { marks, step };
}

/** Compact swimlane timeline of a run: one lane per agent, activity span + event ticks, optional live edge.
 *  With `onTick`, each tick is a click target (with a widened invisible hitbox) for jumping to that entry. */
export function RunTimeline({ agents = [], entries = [], live, selected, onSelect, onTick, height = 22, style }) {
  if (!entries.length) return null;
  const t0 = Math.min(...entries.map((e) => e.ts));
  const last = Math.max(...entries.map((e) => e.ts));
  const t1 = live ? Math.min(Math.max(Date.now(), last), last + 60_000) : last;
  const span = Math.max(t1 - t0, 1000);
  const x = (t) => `${((t - t0) / span) * 100}%`;
  const pct = (t) => ((t - t0) / span) * 100;
  const { marks } = ruler(t0, t0 + span);
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
            <div style={{ position: 'relative', height, background: 'var(--bg-inset)', borderRadius: 4, opacity: dim ? 0.45 : 1, overflow: 'hidden' }}>
              {/* The ruler, behind everything: the same marks on every lane,
                  so two agents' activity can be compared by eye. */}
              {marks.map((t) => (
                <span key={t} aria-hidden="true" style={{
                  position: 'absolute', left: x(t), top: 0, bottom: 0, width: 1,
                  background: 'var(--line)', opacity: 0.9,
                }} />
              ))}
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
      {/* The scale, read like a ruler: the ends anchored, round times between. */}
      <div style={{ position: 'relative', height: 16, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ position: 'absolute', left: 0, top: 0 }}>{fmt(t0)}</span>
        {marks.map((t) => {
          const p = pct(t);
          // Skip a mark that would collide with either end label.
          if (p < 12 || p > 88) return null;
          return (
            <span key={t} style={{ position: 'absolute', left: `${p}%`, top: 0, transform: 'translateX(-50%)', color: 'var(--ink-3, var(--ink-2))' }}>
              {fmt(t)}
            </span>
          );
        })}
        {/* The end time only. The run's total lives in the header meter, once. */}
        <span style={{ position: 'absolute', right: 0, top: 0 }}>{live ? 'now' : fmt(t1)}</span>
      </div>
    </div>
  );
}
