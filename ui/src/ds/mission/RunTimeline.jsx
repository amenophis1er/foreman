import React, { useMemo, useState } from 'react';
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

const LABEL_W = 84;
const GAP = 4;

/**
 * The flow between lanes, read out of the entries. A mission is a tree over
 * time: the director is the trunk, a spawn is a branch off it, a worker's
 * end is a merge back, a message is a line across mid-task, and the human's
 * touches — approvals, questions, steers — are marks on the trunk. Every one
 * of these is already in the log; this is where they become lines.
 */
export function flowEdges(entries, agents) {
  const status = Object.fromEntries((agents ?? []).map((a) => [a.id ?? a, a.status]));
  const edges = [];
  const marks = [];
  const lastOf = new Map();
  for (const e of entries) lastOf.set(e.agent, e);
  for (const e of entries) {
    if (e.kind === 'system' && (e.title === 'spawned' || e.title === 'resumed') && e.agent !== 'director') {
      edges.push({ kind: 'spawn', from: 'director', to: e.agent, ts: e.ts, entry: e, text: `${e.agent} ${e.title}: ${e.body.slice(0, 200)}` });
    } else if (e.kind === 'tool' && e.title === 'message_worker') {
      let to = null; let msg = '';
      try { const input = JSON.parse(e.body); to = input.worker_id ?? null; msg = String(input.message ?? ''); } catch { /* clipped JSON */ }
      if (to) edges.push({ kind: 'message', from: e.agent, to, ts: e.ts, entry: e, text: `${e.agent} → ${to}: ${msg.slice(0, 200)}` });
    } else if (e.kind === 'system' && e.title === 'waiting on you') {
      marks.push({ kind: e.body.startsWith('question') ? 'question' : 'approval', agent: e.agent, ts: e.ts, entry: e, text: e.body.slice(0, 200) });
    } else if (e.kind === 'steer' && e.agent === 'you') {
      marks.push({ kind: 'steer', agent: e.to || 'director', ts: e.ts, entry: e, text: `you → ${e.to || 'director'}: ${e.body.slice(0, 200)}` });
    }
  }
  // A worker that has ended merges back at its last word, coloured by how it ended.
  for (const [agent, last] of lastOf) {
    if (agent === 'director' || agent === 'you' || agent === 'system') continue;
    const st = status[agent];
    if (st && st !== 'running') edges.push({ kind: 'merge', from: agent, to: 'director', ts: last.ts, status: st, entry: last, text: `${agent} ${st}` });
  }
  return { edges, marks };
}

/**
 * Compact swimlane timeline of a run: one lane per agent, activity span, event
 * ticks, and the flow between lanes — spawn branches, merges back, messages
 * across, human marks on the director's lane. Hover anything for the detail;
 * click to jump to that entry in the transcript below, whichever view is open.
 */
export function RunTimeline({ agents = [], entries = [], live, selected, onSelect, onTick, height = 22, style }) {
  const [hover, setHover] = useState(null);
  const t0 = entries.length ? Math.min(...entries.map((e) => e.ts)) : 0;
  const last = entries.length ? Math.max(...entries.map((e) => e.ts)) : 0;
  const t1 = live ? Math.min(Math.max(Date.now(), last), last + 60_000) : last;
  const span = Math.max(t1 - t0, 1000);
  const pct = (t) => ((t - t0) / span) * 100;
  const x = (t) => `${pct(t)}%`;
  const { marks: rulerMarks } = ruler(t0, t0 + span);
  const ids = (agents.length ? agents.map((a) => a.id ?? a) : [...new Set(entries.map((e) => e.agent))])
    .filter((id) => entries.some((e) => e.agent === id));
  const flow = useMemo(() => flowEdges(entries, agents), [entries, agents]);
  if (!entries.length) return null;

  const rowY = (id) => { const i = ids.indexOf(id); return i < 0 ? null : i * (height + GAP) + height / 2; };
  const totalH = ids.length * (height + GAP) - GAP;
  const show = (ev, text, ts) => {
    const box = ev.currentTarget.closest('[data-timeline]').getBoundingClientRect();
    setHover({ left: ev.clientX - box.left, top: ev.clientY - box.top, text, ts });
  };
  const hide = () => setHover(null);
  const edgeColor = (ed) => ed.kind === 'merge'
    ? (ed.status === 'done' ? 'var(--status-good)' : ed.status === 'error' ? 'var(--status-critical)' : 'var(--status-warning)')
    : ed.kind === 'message' ? 'var(--ink-1)' : agentColor(ed.to);

  return (
    <div data-timeline style={{ position: 'relative', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', ...style }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, rowGap: GAP, columnGap: 10 }}>
        {ids.map((id) => {
          const mine = entries.filter((e) => e.agent === id);
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
                {rulerMarks.map((t) => (
                  <span key={t} aria-hidden="true" style={{ position: 'absolute', left: x(t), top: 0, bottom: 0, width: 1, background: 'var(--line)', opacity: 0.9 }} />
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
                  const label = `${e.title || e.kind}${e.kind === 'text' || e.kind === 'system' ? ` — ${e.body.slice(0, 160)}` : ''}`;
                  return (
                    <button key={e.id ?? e.ts} type="button" aria-label={`Jump to ${fmt(e.ts)} ${e.title || e.kind}`}
                      onClick={() => onTick?.(e)} onMouseEnter={(ev) => show(ev, `${e.agent} · ${label}`, e.ts)} onMouseLeave={hide}
                      style={{
                        position: 'absolute', left: x(e.ts), top: 0, bottom: 0, width: 9, marginLeft: -4,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'none', border: 'none', padding: 0, cursor: onTick ? 'pointer' : 'default',
                      }}>{tick}</button>
                  );
                })}
                {live && st === 'running' && <span className="pulse" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 2, background: 'var(--status-good)' }} />}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* The flow, drawn over the lanes: percent x from the same scale as the
          ticks, pixel y from the lane rows. Lines are hit targets too. */}
      <svg aria-hidden="true" style={{ position: 'absolute', left: LABEL_W + 10, right: 0, top: 0, height: totalH, width: `calc(100% - ${LABEL_W + 10}px)`, overflow: 'visible', pointerEvents: 'none' }}>
        {flow.edges.map((ed, i) => {
          const y1 = rowY(ed.from); const y2 = rowY(ed.to);
          if (y1 === null || y2 === null) return null;
          const c = edgeColor(ed);
          const dash = ed.kind === 'message' ? '3 3' : undefined;
          const X = x(ed.ts);
          return (
            <g key={i} style={{ pointerEvents: 'auto', cursor: onTick ? 'pointer' : 'default' }}
              onClick={() => onTick?.(ed.entry)} onMouseEnter={(ev) => show(ev, ed.text, ed.ts)} onMouseLeave={hide}>
              <line x1={X} y1={y1} x2={X} y2={y2} stroke="transparent" strokeWidth={10} />
              <line x1={X} y1={y1} x2={X} y2={y2} stroke={c} strokeWidth={1.5} strokeDasharray={dash} opacity={0.9} />
              <circle cx={X} cy={y2} r={3} fill={c} />
              {ed.kind === 'merge' && <circle cx={X} cy={y1} r={2} fill={c} />}
            </g>
          );
        })}
        {flow.marks.map((m, i) => {
          const y = rowY(m.agent) ?? rowY('director');
          if (y === null) return null;
          const c = m.kind === 'steer' ? 'var(--brand)' : 'var(--status-warning)';
          const X = x(m.ts);
          return (
            <g key={`m${i}`} style={{ pointerEvents: 'auto', cursor: onTick ? 'pointer' : 'default' }}
              onClick={() => onTick?.(m.entry)} onMouseEnter={(ev) => show(ev, m.text, m.ts)} onMouseLeave={hide}>
              <circle cx={X} cy={y - height / 2 - 1} r={5} fill="var(--bg-panel)" stroke={c} strokeWidth={1.5} />
              <text x={X} y={y - height / 2 + 2} textAnchor="middle" fontSize={7} fill={c} style={{ fontWeight: 700 }}>
                {m.kind === 'question' ? '?' : m.kind === 'steer' ? '›' : '!'}
              </text>
            </g>
          );
        })}
      </svg>

      {hover && (
        <div style={{
          position: 'absolute', left: Math.min(hover.left + 12, 9999), top: hover.top + 14, zIndex: 10, maxWidth: 360,
          background: 'var(--bg-card)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)', padding: '6px 8px', color: 'var(--ink-0)', pointerEvents: 'none',
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 'var(--lh)',
        }}>
          <div style={{ color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', marginBottom: 2 }}>{fmt(hover.ts)}</div>
          {hover.text}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px 1fr`, columnGap: 10, marginTop: GAP }}>
        <span />
        <div style={{ position: 'relative', height: 16, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ position: 'absolute', left: 0, top: 0 }}>{fmt(t0)}</span>
          {rulerMarks.map((t) => {
            const p = pct(t);
            if (p < 12 || p > 88) return null;
            return (
              <span key={t} style={{ position: 'absolute', left: `${p}%`, top: 0, transform: 'translateX(-50%)', color: 'var(--ink-3, var(--ink-2))' }}>
                {fmt(t)}
              </span>
            );
          })}
          <span style={{ position: 'absolute', right: 0, top: 0 }}>{live ? 'now' : fmt(t1)}</span>
        </div>
      </div>
    </div>
  );
}
