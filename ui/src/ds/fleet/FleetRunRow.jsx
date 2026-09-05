import React, { useState } from 'react';
import { BudgetMeter } from '../status/BudgetMeter';
import { shortPath } from '../core/path';
import { formatWait } from './NeedsBoard';

/**
 * One running mission on the board. A row, not a card: the running section
 * is read down a list — who, what, how far, how much — and rows keep those
 * four in the same columns from one project to the next.
 *
 * The crew's line sits under the title in mono because it is the answer to
 * "is it actually doing anything": a row whose line has not changed between
 * two glances is the stall the meter cannot show.
 */
export function FleetRunRow({
  name, folder, title, mission, activity,
  costUsd, budgetUsd, costBasis, usage, turns,
  directorModel, workerModel, createdAt, onOpen, style,
}) {
  const [hover, setHover] = useState(false);
  const models = [directorModel, workerModel].filter(Boolean);
  return (
    <div role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(); } }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(9rem, 12rem) minmax(0, 1fr) minmax(11rem, 15rem) auto',
        gap: 'var(--sp-4)', alignItems: 'center',
        padding: 'var(--sp-3) var(--sp-4)', cursor: 'pointer',
        background: hover ? 'var(--bg-hover)' : 'transparent',
        borderLeft: `var(--accent-w) solid ${hover ? 'var(--brand)' : 'transparent'}`,
        transition: 'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
        ...style,
      }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', color: 'var(--ink-0)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{name}</div>
        <div title={folder} style={{
          fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{shortPath(folder)}</div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div title={mission} style={{
          fontSize: 'var(--fs-md)', color: 'var(--ink-0)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title || mission}</div>
        {activity && (
          <div key={activity} className="ticker" title={activity} style={{
            fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{activity}</div>
        )}
      </div>

      {/* The same meter as the run header: dollars only when priced, tokens
          and turns otherwise, striped when the spend is real but unpriced. */}
      <BudgetMeter spent={costUsd} budget={budgetUsd} costBasis={costBasis} usage={usage} turns={turns} />

      <div style={{
        textAlign: 'right', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
        fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>
        {models.length > 0 && (
          <div title={`director · worker`} style={{ maxWidth: '16rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {models.join(' · ')}
          </div>
        )}
        {typeof createdAt === 'number' && <div>{formatWait(createdAt)}</div>}
      </div>
    </div>
  );
}
