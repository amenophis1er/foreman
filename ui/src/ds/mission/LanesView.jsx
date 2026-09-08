import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../core/Icon';
import { Button } from '../core/Button';
import { StatusBadge } from '../status/StatusBadge';
import { TranscriptEntry } from './TranscriptEntry';

/**
 * The transcript as lanes: one column per agent, side by side, on a shared
 * time axis.
 *
 * The unified transcript answers "what happened next"; this answers "what was
 * worker 3 doing while worker 5 was blocked". Rows are time buckets, not
 * events — a minute on a short run, five or fifteen on a long one — so a
 * chatty minute stacks inside its cell and a quiet one is a thin line, and
 * the grid stays dense instead of one event per row with seven empty cells
 * beside it. Lanes never shrink to fit: four read comfortably on a laptop,
 * more scroll sideways. Finished agents fold into a dropdown at the end of the
 * strip, the way golden-eye parks its done sessions; pick one and it is a lane
 * again. Entries are the same components the unified view renders.
 */

const LANE_W = 360;
const RULER_W = 64;

/** Bucket width from the run's span: keeps the ruler to a few dozen rows. */
export function bucketMsFor(spanMs) {
  if (spanMs <= 15 * 60_000) return 60_000;
  if (spanMs <= 90 * 60_000) return 5 * 60_000;
  if (spanMs <= 6 * 3_600_000) return 15 * 60_000;
  return 60 * 60_000;
}

/**
 * Rows for the grid: `{ t0, cells: Map<agent, Entry[]> }` for buckets with
 * anything in a shown lane, and `{ quiet: n }` for stretches with nothing.
 */
export function bucketRows(entries, lanes, bucketMs, endMs) {
  const shown = new Set(lanes);
  const relevant = entries.filter((e) => shown.has(e.agent));
  if (!relevant.length) return [];
  const start = Math.floor(relevant[0].ts / bucketMs) * bucketMs;
  const end = Math.max(relevant[relevant.length - 1].ts, endMs ?? 0);
  const byBucket = new Map();
  for (const e of relevant) {
    const t0 = Math.floor(e.ts / bucketMs) * bucketMs;
    let cells = byBucket.get(t0);
    if (!cells) { cells = new Map(); byBucket.set(t0, cells); }
    let list = cells.get(e.agent);
    if (!list) { list = []; cells.set(e.agent, list); }
    list.push(e);
  }
  const rows = [];
  let quiet = 0;
  for (let t0 = start; t0 <= end; t0 += bucketMs) {
    const cells = byBucket.get(t0);
    if (!cells) { quiet += 1; continue; }
    if (quiet) { rows.push({ quiet, t0: t0 - quiet * bucketMs, ms: quiet * bucketMs }); quiet = 0; }
    rows.push({ t0, cells });
  }
  return rows;
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const mins = (ms) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(ms % 3_600_000 ? 1 : 0)} h` : `${Math.round(ms / 60_000)} min`);
const usd = (n) => `$${(n ?? 0).toFixed(2)}`;

/** What a lane header says about its agent, from its entries and the run's worker record. */
function laneFacts(agent, entries, worker) {
  const mine = entries.filter((e) => e.agent === agent);
  const tools = mine.filter((e) => e.kind === 'tool');
  const counts = new Map();
  for (const t of tools) { const name = t.title.split(/\s|·/)[0] || t.title; counts.set(name, (counts.get(name) ?? 0) + 1); }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return {
    started: mine[0]?.ts, last: mine[mine.length - 1]?.ts,
    lastTool: tools[tools.length - 1]?.title.split(/\s|·/)[0],
    toolCount: tools.length, top, cost: worker?.costUsd,
  };
}

function LaneHeader({ agent, status, facts, onClose, canClose }) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-panel)', borderBottom: '1px solid var(--line)',
      padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={{ fontWeight: 'var(--fw-semibold)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent}</span>
        <StatusBadge status={status} />
        {canClose && (
          <button type="button" onClick={onClose} title="Fold this lane away"
            style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--ink-2)', display: 'inline-flex' }}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', flexWrap: 'wrap' }}>
        {facts.cost !== undefined && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(facts.cost)}</span>}
        {facts.started && <span>from {hhmm(facts.started)}</span>}
        {facts.toolCount > 0 && <span>{facts.toolCount} tool call{facts.toolCount === 1 ? '' : 's'}</span>}
        {facts.lastTool && <span>last {facts.lastTool}</span>}
      </div>
      {facts.top.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {facts.top.map(([name, n]) => (
            <span key={name} style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', padding: '0 5px', borderRadius: 'var(--r-pill)', border: '1px solid var(--line)', color: 'var(--ink-1)' }}>{name} {n}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The parked agents: a dropdown at the end of the strip, one click brings a lane back. */
function Parked({ agents, workers, onPick }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (!agents.length) return null;
  const allDone = agents.every((a) => a.status !== 'running');
  return (
    <div ref={box} style={{ position: 'relative', flex: '0 0 auto' }}>
      <Button variant="ghost" size="sm" icon={allDone ? 'done' : 'crew'} onClick={() => setOpen(!open)}>
        {allDone ? 'Done' : 'More'} ({agents.length}) <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
      </Button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 5, minWidth: 280,
          background: 'var(--bg-card)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-md)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.25)', padding: 4, display: 'flex', flexDirection: 'column',
        }}>
          {agents.map((a) => {
            const w = workers.find((x) => x.id === a.id);
            return (
              <button key={a.id} type="button" onClick={() => { onPick(a.id); setOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'none', border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer', color: 'inherit', font: 'inherit', textAlign: 'left' }}>
                <StatusBadge status={a.status} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.id}</span>
                {w && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>{usd(w.costUsd)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A long entry in a lane is clamped to a few lines with a "more" toggle: a
 * lane is for seeing what each agent was doing beside the others, and one
 * ten-screen result would push every other lane's next hour off the page.
 * The unified view still shows entries whole.
 */
function Clamped({ id, long, children }) {
  const [open, setOpen] = useState(false);
  if (!long) return <div id={id}>{children}</div>;
  return (
    <div id={id} style={{ position: 'relative' }}>
      <div style={open ? undefined : { maxHeight: 180, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black 70%, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent)' }}>
        {children}
      </div>
      <button type="button" onClick={() => setOpen(!open)}
        style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-xs)', color: 'var(--brand)' }}>
        {open ? 'less' : 'more'}
      </button>
    </div>
  );
}

/**
 * Consecutive tool calls and their results fold into one line. A lane is for
 * what an agent said and decided beside the others; thirty Bash results in a
 * five-minute bucket are activity, not narrative, and the unified view still
 * has every one of them. The fold opens in place when the detail matters.
 */
export function foldTools(entries) {
  const out = [];
  for (const e of entries) {
    if (e.kind === 'tool' || e.kind === 'result') {
      const last = out[out.length - 1];
      if (last?.burst) last.entries.push(e); else out.push({ burst: true, entries: [e] });
    } else {
      out.push({ entry: e });
    }
  }
  // A lone tool line is shown as itself; folding one thing hides more than it saves.
  return out.map((item) => (item.burst && item.entries.length === 1 ? { entry: item.entries[0] } : item));
}

function ToolBurst({ entries }) {
  const [open, setOpen] = useState(false);
  const calls = entries.filter((e) => e.kind === 'tool');
  const counts = new Map();
  for (const c of calls) { const name = c.title.split(/\s|·/)[0] || c.title; counts.set(name, (counts.get(name) ?? 0) + 1); }
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ${k}`).join(' · ');
  const errors = entries.filter((e) => e.kind === 'result' && /error|failed|denied/i.test(e.body.slice(0, 200))).length;
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'var(--bg-inset)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '4px 8px', cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-xs)', color: 'var(--ink-1)', textAlign: 'left' }}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {calls.length} tool call{calls.length === 1 ? '' : 's'}{summary ? `: ${summary}` : ''}
        </span>
        {errors > 0 && <span style={{ color: 'var(--status-critical)' }}>{errors} error{errors === 1 ? '' : 's'}</span>}
        <span style={{ color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>{hhmm(entries[0].ts)}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          {entries.map((e) => (
            <Clamped key={e.id} id={`lane-entry-${e.id}`} long={e.body.length > 600}>
              <TranscriptEntry agent={e.agent} title={e.title} dense kind={e.kind} body={e.body} ts={e.ts} />
            </Clamped>
          ))}
        </div>
      )}
    </div>
  );
}

export function LanesView({ agents = [], entries = [], workers = [], lanes, onLanes, order = 'oldest', live = false, style }) {
  const shownAgents = lanes.map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  const parked = agents.filter((a) => !lanes.includes(a.id));
  const span = entries.length ? (live ? Date.now() : entries[entries.length - 1].ts) - entries[0].ts : 0;
  const bucketMs = bucketMsFor(span);
  const rows = useMemo(() => bucketRows(entries, lanes, bucketMs, live ? Date.now() : undefined), [entries, lanes, bucketMs, live]);
  const ordered = order === 'newest' ? [...rows].reverse() : rows;
  const factsByAgent = useMemo(() => Object.fromEntries(shownAgents.map((a) => [a.id, laneFacts(a.id, entries, workers.find((w) => w.id === a.id))])), [shownAgents, entries, workers]);

  const cols = `${RULER_W}px ${shownAgents.map(() => `${LANE_W}px`).join(' ')}`;
  const cell = { borderBottom: '1px solid var(--line)', borderLeft: '1px solid var(--line)', padding: 6, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, overflowX: 'auto' };

  return (
    <div style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', ...style }}>
      {/* What is folded away, one click from a lane — above the grid, where the
          list has room to open and is seen before the reader scrolls. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '2px var(--sp-3) 0', gap: 8, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
        <span>{shownAgents.length} lane{shownAgents.length === 1 ? '' : 's'} · rows of {mins(bucketMs)}</span>
        <Parked agents={parked} workers={workers} onPick={(id) => onLanes([...lanes, id])} />
      </div>
      <div style={{ overflow: 'auto', minHeight: 0, flex: 1, padding: '0 var(--sp-3) var(--sp-3)' }}>
        <div style={{ display: 'inline-grid', gridTemplateColumns: cols, minWidth: '100%', background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)' }}>
          {/* Header row: the ruler's corner says the bucket; each lane its agent. */}
          <div style={{ position: 'sticky', top: 0, left: 0, zIndex: 3, background: 'var(--bg-panel)', borderBottom: '1px solid var(--line)', padding: '6px 8px', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            time
          </div>
          {shownAgents.map((a) => (
            <LaneHeader key={a.id} agent={a.id} status={a.status} facts={factsByAgent[a.id]}
              canClose={shownAgents.length > 1} onClose={() => onLanes(lanes.filter((id) => id !== a.id))} />
          ))}
          {ordered.map((row) => row.quiet ? (
            <React.Fragment key={`q${row.t0}`}>
              <div style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-panel)', borderBottom: '1px solid var(--line)', padding: '2px 8px', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{hhmm(row.t0)}</div>
              <div style={{ gridColumn: `2 / span ${shownAgents.length}`, borderBottom: '1px solid var(--line)', borderLeft: '1px solid var(--line)', padding: '2px 8px', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', background: 'var(--bg-inset)' }}>
                {mins(row.ms)} quiet
              </div>
            </React.Fragment>
          ) : (
            <React.Fragment key={row.t0}>
              <div style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-panel)', borderBottom: '1px solid var(--line)', padding: '6px 8px', fontSize: 'var(--fs-xs)', color: 'var(--ink-1)', fontVariantNumeric: 'tabular-nums' }}>{hhmm(row.t0)}</div>
              {shownAgents.map((a) => (
                <div key={a.id} style={cell}>
                  {foldTools(row.cells.get(a.id) ?? []).map((item) => item.burst ? (
                    <ToolBurst key={`b${item.entries[0].id}`} entries={item.entries} />
                  ) : (
                    <Clamped key={item.entry.id} id={`lane-entry-${item.entry.id}`} long={item.entry.body.length > 600}>
                      <TranscriptEntry agent={item.entry.agent} title={item.entry.title} dense kind={item.entry.kind} body={item.entry.body} ts={item.entry.ts} to={item.entry.to} timing={item.entry.timing} />
                    </Clamped>
                  ))}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
