import React, { useState } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { TextInput } from '../forms/TextInput';
import { Banner } from '../status/Banner';

/**
 * The handoff: a mission the planner drafted, for the human to read, edit and
 * start. This card *is* the moment of commitment — the point where a
 * conversation that has only been reading becomes a crew that will write. So
 * it states what will be done, how completion will be judged, and what it may
 * cost, and it never starts anything on its own.
 *
 * The brief and the budget are editable in place. Everything else is a
 * conversation away: to change the shape, say so and let the planner redraft.
 */
export function ProposalCard({ mission, doneWhen = [], budgetUsd = 5, rationale, busy, error, onStart, onDismiss, style }) {
  const [brief, setBrief] = useState(mission);
  const [budget, setBudget] = useState(budgetUsd);
  const edited = brief !== mission || Number(budget) !== Number(budgetUsd);

  return (
    <section style={{
      background: 'var(--bg-card)', border: '1px solid var(--brand)',
      borderRadius: 'var(--r-md)', padding: 'var(--sp-4)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', ...style,
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        <Icon name="orchestration" size={16} color="var(--brand)" />
        <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>Proposed mission</span>
        {edited && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>edited</span>
        )}
      </header>

      {rationale && (
        <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--ink-1)' }}>{rationale}</p>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{
          fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase',
          letterSpacing: 'var(--ls-caps)',
        }}>Brief</span>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={6}
          style={{
            resize: 'vertical', minHeight: '6rem', background: 'var(--bg-inset)',
            border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
            padding: 'var(--sp-2) var(--sp-3)', color: 'var(--ink-0)', font: 'inherit',
            lineHeight: 'var(--lh-prose)', outline: 'none',
          }} />
      </label>

      {doneWhen.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{
            fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase',
            letterSpacing: 'var(--ls-caps)',
          }}>Done when</span>
          {/* Unticked boxes, deliberately: this is what the director will be
              held to, not a list of things already true. */}
          {doneWhen.map((d, i) => (
            <div key={i} style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
            }}>
              <span style={{ color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', flex: '0 0 auto' }}>▢</span>
              <span>{d}</span>
            </div>
          ))}
        </div>
      )}

      {error && <Banner tone="error" inline>{error}</Banner>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-sm)', color: 'var(--ink-1)' }}>
          Budget cap
          <TextInput type="number" prefix="$" min={0} step={1} width={110}
            value={budget} onChange={setBudget} />
        </label>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--sp-2)' }}>
          <Button variant="ghost" onClick={onDismiss} disabled={busy}>Not this one</Button>
          <Button variant="primary" icon="orchestration" disabled={busy || !brief.trim()}
            title="Starts the mission: a director plans it and workers do the work"
            onClick={() => onStart?.({ mission: brief.trim(), budget: Number(budget) || budgetUsd })}>
            {busy ? 'Starting…' : 'Start mission'}
          </Button>
        </span>
      </div>
    </section>
  );
}
