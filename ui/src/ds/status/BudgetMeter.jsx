import React from 'react';
import { Icon } from '../core/Icon';

/** Budget spend: thin track + escalating fill, with the dollar figures always readable as text. */
export function BudgetMeter({ spent, budget, style }) {
  spent = Number(spent) || 0;
  budget = Number(budget) || 0;
  const frac = budget > 0 ? Math.min(spent / budget, 1) : 0;
  const level = frac >= 0.9 ? 'critical' : frac >= 0.7 ? 'warning' : 'ok';
  const barColor = level === 'critical' ? 'var(--status-critical)'
    : level === 'warning' ? 'var(--status-warning)' : 'var(--brand)';
  return (
    <div
      title={`$${spent.toFixed(2)} spent of $${budget.toFixed(2)} budget`}
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 170, ...style }}
    >
      <div style={{ flex: 1, height: 'var(--meter-h)', background: 'var(--bg-inset)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${frac * 100}%`, height: '100%', background: barColor, transition: 'width var(--dur-meter)' }} />
      </div>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {level !== 'ok' && <Icon name={level} size={12} strokeWidth={2.25} color={barColor} />}
        ${spent.toFixed(2)} / ${budget.toFixed(0)}
      </span>
    </div>
  );
}
