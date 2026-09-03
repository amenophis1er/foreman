import React, { useState } from 'react';
import { SectionTitle } from '../core/SectionTitle';
import { Empty } from '../core/Empty';
import { Icon } from '../core/Icon';

/** Parse `- [ ]` / `- [x]` items out of MISSION.md. */
export function parsePlan(doc) {
  return [...String(doc || '').matchAll(/^\s*-\s*\[([ xX])\]\s*(.+)$/gm)]
    .map((m) => ({ done: m[1] !== ' ', text: m[2].trim() }));
}
/** Bundle-reachable alias of `parsePlan`. */
export const ParsePlan = parsePlan;

/** Live checklist parsed from the director's MISSION.md, with a raw-document escape hatch. */
export function PlanBoard({ doc, style }) {
  const [raw, setRaw] = useState(false);
  const items = doc ? parsePlan(doc) : [];
  const done = items.filter((i) => i.done).length;
  return (
    <section style={style}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
        <SectionTitle>Plan</SectionTitle>
        {items.length > 0 && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>{done}/{items.length}</span>
        )}
        {doc && (
          <button type="button" onClick={() => setRaw(!raw)} style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--ink-2)', fontSize: 'var(--fs-xs)', padding: 0, font: 'inherit',
          }}><Icon name="raw" size={12} />{raw ? 'board' : 'raw doc'}</button>
        )}
      </div>
      {items.length > 0 && !raw && (
        <div style={{ height: 3, background: 'var(--bg-inset)', borderRadius: 2, marginBottom: 6, overflow: 'hidden' }}>
          <div style={{ width: `${(done / items.length) * 100}%`, height: '100%', background: 'var(--status-good)', transition: 'width var(--dur-meter)' }} />
        </div>
      )}
      {!doc && <Empty>MISSION.md not written yet.</Empty>}
      {doc && !raw && items.map((i, n) => (
        <div key={n} style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)', padding: '4px 0',
          fontSize: 'var(--fs-sm)', color: i.done ? 'var(--ink-2)' : 'var(--ink-0)',
        }}>
          <Icon name={i.done ? 'done' : 'idle'} size={14} strokeWidth={2} color={i.done ? 'var(--status-good)' : 'var(--ink-2)'} style={{ marginTop: 2 }} />
          <span style={{ textDecoration: i.done ? 'line-through' : 'none' }}>{i.text}</span>
        </div>
      ))}
      {doc && raw && (
        <pre style={{
          fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', color: 'var(--ink-1)',
          background: 'var(--bg-inset)', borderRadius: 'var(--r-sm)', padding: 'var(--sp-2)',
          maxHeight: 320, overflowY: 'auto', fontFamily: 'var(--font-mono)', margin: 0,
        }}>{doc}</pre>
      )}
    </section>
  );
}
