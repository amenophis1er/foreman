import React from 'react';

/** A unified diff, line by line. Only the sign decides the tint; hunk headers step back to `--ink-2`. */
export function Diff({ text, truncated, style }) {
  const lines = String(text || '').split('\n');
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', lineHeight: 'var(--lh)',
      background: 'var(--bg-inset)', overflowX: 'auto', ...style,
    }}>
      {lines.map((l, i) => {
        const head = l.startsWith('@@') || l.startsWith('diff ') || l.startsWith('index ')
          || l.startsWith('--- ') || l.startsWith('+++ ');
        const add = !head && l.startsWith('+');
        const del = !head && l.startsWith('-');
        return (
          <div key={i} style={{
            padding: '0 var(--sp-2)', whiteSpace: 'pre',
            background: add ? 'var(--diff-add-bg)' : del ? 'var(--diff-del-bg)' : 'transparent',
            color: head ? 'var(--ink-2)' : 'var(--ink-0)',
          }}>{l || ' '}</div>
        );
      })}
      {truncated && (
        <div style={{ padding: '2px var(--sp-2)', color: 'var(--ink-2)', fontFamily: 'var(--font-ui)' }}>
          first 400 lines — the rest is in your working tree
        </div>
      )}
    </div>
  );
}
