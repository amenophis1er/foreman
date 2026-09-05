import React from 'react';
import { Icon } from '../core/Icon';

function plural(n, word) { return `${n} ${word}${n > 1 ? 's' : ''}`; }

/** The pulsing "needs you" line on a fleet card — the only attention-seeking element in Foreman. */
export function NeedsYouStrip({ approvals = 0, questions = 0, planner = false, style }) {
  approvals = Number(approvals) || 0;
  questions = Number(questions) || 0;
  if (approvals + questions === 0) return null;
  const parts = [];
  if (approvals > 0) parts.push(plural(approvals, 'approval'));
  // A planner question is one of the `questions`; name it, because the human
  // goes to a different place to answer it (the chat, not a run).
  const runQuestions = planner ? questions - 1 : questions;
  if (runQuestions > 0) parts.push(plural(runQuestions, 'question'));
  if (planner) parts.push('the planner is asking');
  return (
    <div className="pulse" style={{
      display: 'flex', alignItems: 'center', gap: 6,
      color: 'var(--status-warning)', fontSize: 'var(--fs-sm)',
      fontWeight: 'var(--fw-semibold)', ...style,
    }}>
      <Icon name="needsYou" size={14} strokeWidth={2} />
      Needs you — {parts.join(', ')}
    </div>
  );
}
