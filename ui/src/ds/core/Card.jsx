import React from 'react';

/** The universal surface. An `accent` turns the left border into a 3px identity or status stripe. */
export function Card({ children, accent, tone = 'card', style, onClick, title }) {
  const bg = tone === 'panel' ? 'var(--bg-panel)' : tone === 'inset' ? 'var(--bg-inset)' : 'var(--bg-card)';
  return (
    <div
      onClick={onClick}
      title={title}
      role={onClick ? 'button' : undefined}
      style={{
        background: bg,
        border: '1px solid var(--line)',
        borderLeft: accent ? `var(--accent-w) solid ${accent}` : '1px solid var(--line)',
        borderRadius: 'var(--r-sm)',
        padding: 'var(--sp-3)',
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
    >{children}</div>
  );
}
