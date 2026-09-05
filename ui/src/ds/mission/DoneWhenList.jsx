import React from 'react';
import { Icon } from '../core/Icon';
import { Empty } from '../core/Empty';

/**
 * The DONE WHEN criteria out of MISSION.md: checkbox lines under the first
 * `DONE WHEN` heading, up to the next heading. The same rule as the server's
 * `unmetCriteria`, so what the list shows as unmet is what would stop the
 * run from being called done. Null when the doc has no such section.
 */
export function parseDoneWhen(doc) {
  if (!doc) return null;
  const lines = String(doc).split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s*DONE\s*WHEN/i.test(l.trim()));
  if (start === -1) return null;
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break; // the section ends at the next heading
    const box = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/);
    if (!box) continue;
    // Inline emphasis and code ticks are noise in a checklist line.
    const text = box[2].trim().replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1');
    items.push({ text, done: box[1] !== ' ' });
  }
  return items.length ? items : null;
}

/** The label with its count — exported so a disclosure can name the list without opening it. */
export function doneWhenLabel(items) {
  if (!items) return 'Done when';
  return `Done when · ${items.filter((i) => i.done).length} / ${items.length}`;
}

/**
 * The mission's finish line as a live checklist. This is the one thing the
 * human should be able to see without reading the transcript: what "done"
 * means for this mission and how much of it is true yet.
 */
export function DoneWhenList({ doc, style }) {
  const items = parseDoneWhen(doc);
  const done = items ? items.filter((i) => i.done).length : 0;
  return (
    <section style={style}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)',
        fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)', textTransform: 'uppercase',
        letterSpacing: 'var(--ls-caps)', color: 'var(--ink-2)',
      }}>
        <span>Done when</span>
        {items && (
          <span style={{
            fontVariantNumeric: 'tabular-nums', textTransform: 'none', letterSpacing: 0,
            color: done === items.length ? 'var(--status-good)' : 'var(--ink-1)',
          }}>{done} / {items.length}</span>
        )}
      </div>
      {!doc && <Empty>MISSION.md not written yet.</Empty>}
      {doc && !items && <Empty>No DONE WHEN section in the mission doc.</Empty>}
      {items && items.map((i, n) => (
        <div key={n} style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)', padding: '3px 0',
          fontSize: 'var(--fs-sm)', lineHeight: 'var(--lh)',
          color: i.done ? 'var(--ink-2)' : 'var(--ink-0)',
        }}>
          <Icon name={i.done ? 'done' : 'idle'} size={14} strokeWidth={2}
            color={i.done ? 'var(--status-good)' : 'var(--ink-2)'} style={{ marginTop: 2 }} />
          <span style={{ textDecoration: i.done ? 'line-through' : 'none' }}>{i.text}</span>
        </div>
      ))}
    </section>
  );
}
