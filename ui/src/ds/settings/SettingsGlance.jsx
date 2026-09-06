import React from 'react';
import { SectionTitle } from '../core/SectionTitle';
import { Button } from '../core/Button';

/**
 * The project's effective settings, readable in the rail: what a mission
 * started here would run with, and which of those the project overrides.
 * Read-only on purpose — one place edits settings, and this is the glance
 * that makes that place easy to find.
 */
export function SettingsGlance({ effective = {}, overrides = [], onOpen, style }) {
  const over = new Set(overrides);
  const pct = (n) => (typeof n === 'number' ? `${n}%` : '—');
  const usd = (n) => (typeof n === 'number' ? `$${n}` : '—');
  const rows = [
    ['director', effective.directorModel || 'default', 'directorModel'],
    ['workers', effective.workerModel || 'default', 'workerModel'],
    ['planner', effective.plannerModel || 'sonnet', 'plannerModel'],
    ['cap per run', usd(effective.budgetCap), 'budgetCap'],
    ['warn at', pct(effective.budgetWarnAt), 'budgetWarnAt'],
    ['at the cap', effective.budgetHardStop === false ? 'pause and ask' : 'hard stop', 'budgetHardStop'],
    ['read-only tools', effective.autoAllowReadOnly === false ? 'ask' : 'auto-allow', 'autoAllowReadOnly'],
  ];
  return (
    <section style={{ minWidth: 0, ...style }}>
      <SectionTitle>Settings</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', columnGap: 10, rowGap: 2, fontSize: 'var(--fs-xs)', alignItems: 'baseline' }}>
        {rows.map(([label, value, key]) => (
          <React.Fragment key={key}>
            <span style={{ color: 'var(--ink-2)' }}>{label}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={String(value)}>{value}</span>
            <span style={{ color: 'var(--brand)', fontSize: 'var(--fs-xs)' }} title={over.has(key) ? 'Set on this project; the rest inherit Global' : undefined}>
              {over.has(key) ? 'override' : ''}
            </span>
          </React.Fragment>
        ))}
      </div>
      {onOpen && (
        <Button variant="ghost" size="sm" icon="settings" onClick={onOpen} style={{ marginTop: 6 }}
          title="Open this project's settings">Change…</Button>
      )}
    </section>
  );
}
