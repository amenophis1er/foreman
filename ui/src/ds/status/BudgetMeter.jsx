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
 * An indeterminate track: structure, carrying no claim about magnitude.
 *
 * Used where something is genuinely being consumed but the amount is unknown.
 * The stripes are the honest shape of "some, of an amount nobody here can
 * state" — a partial fill would be a number, and there is no number.
 */
const STRIPES = 'repeating-linear-gradient(-45deg, var(--line-strong) 0 3px, transparent 3px 7px)';

/**
 * Budget spend: thin track + escalating fill, with the figures always
 * readable as text.
 *
 * Only `costBasis === 'priced'` prints a dollar sign. Foreman's one loud
 * promise is never lying about who pays, and through a gateway the SDK prices
 * foreign tokens with a table that does not apply — so the other two bases
 * render tokens and turns, which are what actually moved.
 *
 * `free` and `unpriced` are deliberately NOT the same rendering. This meter
 * used to carry a single tooltip that read "a local model has no per-token
 * cost, and an external endpoint's spend is real but Foreman does not have
 * its price table" — one sentence covering two opposite situations, because
 * the boolean behind it could not tell them apart. An empty track says
 * nothing is being spent; a striped one says something is, and that no one
 * here can say how much.
 */
export function BudgetMeter({ spent, budget, costBasis = 'priced', usage = null, turns, detail = false, style }) {
  spent = Number(spent) || 0;
  budget = Number(budget) || 0;

  if (costBasis !== 'priced') {
    const unpriced = costBasis === 'unpriced';
    const tokens = sumUsage(usage);
    // The two numbers that would fill this track honestly — the turn cap and
    // the wall-clock cap — are server-side defaults the component is never
    // given. Fabricating a fraction from them would be the exact lie this
    // mode exists to avoid, so the bar makes no magnitude claim either way.
    return (
      <div
        title={unpriced
          ? 'Real spend, on an account Foreman cannot price — no table for this endpoint, or a plan being drawn down. Check the provider for the bill; turns and tokens are all that is known here.'
          : 'Runs on hardware you already own, so nothing is billed per token. Turns and tokens are the only real units.'}
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 170, ...style }}
      >
        <div style={{
          flex: 1, height: 'var(--meter-h)', background: 'var(--bg-inset)',
          borderRadius: 2, overflow: 'hidden',
          backgroundImage: unpriced ? STRIPES : undefined,
        }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {/* One total answers "is anything happening"; the split answers
              "what kind of work is this", which is the more useful question
              wherever there is room for it. Output tokens are what a model
              actually generates and are priced several times higher than
              input, so a run that is 90% input is a different animal from one
              that is 90% output — and a single summed figure hides that. */}
          {detail
            ? `${formatTokens(usage?.inputTokens ?? 0)} in · ${formatTokens(usage?.outputTokens ?? 0)} out`
            : `${formatTokens(tokens)} tok`}
          {typeof turns === 'number' ? ` · ${turns} turn${turns === 1 ? '' : 's'}` : ''}
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
