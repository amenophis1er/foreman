import React from 'react';
import { Icon } from '../core/Icon';
import { Button } from '../core/Button';

function plural(n, word) { return `${n} ${word}${n > 1 ? 's' : ''}`; }

/** Persistent strip above the transcript while approvals or questions are pending. Not a toast: it stays until resolved. */
export function AttentionBar({ approvals = 0, questions = 0, onReview, style }) {
  approvals = Number(approvals) || 0;
  questions = Number(questions) || 0;
  if (approvals + questions === 0) return null;
  const parts = [];
  if (approvals > 0) parts.push(plural(approvals, 'approval'));
  if (questions > 0) parts.push(plural(questions, 'question'));
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
      padding: '6px 10px 6px 12px', borderRadius: 'var(--r-sm)',
      background: 'color-mix(in srgb, var(--status-warning) 10%, var(--bg-card))',
      border: '1px solid color-mix(in srgb, var(--status-warning) 45%, transparent)',
      fontSize: 'var(--fs-sm)', color: 'var(--ink-0)', ...style,
    }}>
      <Icon name="needsYou" size={15} strokeWidth={2} color="var(--status-warning)" style={{ animation: 'pulse var(--dur-pulse) var(--ease) infinite' }} />
      <span><b style={{ fontWeight: 'var(--fw-semibold)' }}>The run is waiting on you</b> — {parts.join(', ')} pending.</span>
      <span style={{ flex: 1 }} />
      <Button size="sm" onClick={onReview}>Review</Button>
    </div>
  );
}
