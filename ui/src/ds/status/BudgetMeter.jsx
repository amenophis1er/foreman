import React from 'react';
import { Icon } from '../core/Icon';

/** 12,345 -> "12.3k". Tokens run into the millions where raw digits stop being
 * readable at a glance; a run's dollar figure never needed this because it
 * stays small by construction, but token counts do not have that property. */
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const sumUsage = (u) => (u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0);

/**
 * Budget spend: thin track + escalating fill, with the figures always
 * readable as text. `metered === false` means `spent` is not real money (a
 * gateway priced local or third-party tokens with a table that does not
 * apply) — Foreman's one loud promise is never lying about who pays, so this
 * mode renders tokens and turns instead and never prints a dollar sign.
 */
export function BudgetMeter({ spent, budget, metered = true, usage = null, turns, style }) {
  spent = Number(spent) || 0;
  budget = Number(budget) || 0;

  if (!metered) {
    const tokens = sumUsage(usage);
    // The track still needs to mean something, but the two numbers that would
    // fill it honestly — the 60-turn cap and the 45-minute wall-clock cap —
    // are server-side defaults this component is never given. Fabricating a
    // fraction from them here would be the exact lie this mode exists to
    // avoid, so the bar stays an empty track: visible structure, no claim.
    return (
      <div
        title="No dollar figure: a local model has no per-token cost, and an external endpoint's spend is real but Foreman does not have its price table. Turns and tokens are what's actually known."
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 170, ...style }}
      >
        <div style={{ flex: 1, height: 'var(--meter-h)', background: 'var(--bg-inset)', borderRadius: 2, overflow: 'hidden' }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {formatTokens(tokens)} tok{typeof turns === 'number' ? ` · ${turns} turn${turns === 1 ? '' : 's'}` : ''}
        </span>
      </div>
    );
  }

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
