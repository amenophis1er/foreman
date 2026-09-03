import React from 'react';

/** 11px uppercase letterspaced rail heading — AGENTS, RUNS, APPROVALS, QUESTIONS, PLAN. */
export function SectionTitle({ children, style }) {
  return (
    <h2 style={{
      margin: '0 0 var(--sp-2)',
      fontSize: 'var(--fs-xs)',
      fontWeight: 'var(--fw-semibold)',
      textTransform: 'uppercase',
      letterSpacing: 'var(--ls-caps)',
      color: 'var(--ink-2)',
      ...style,
    }}>{children}</h2>
  );
}
