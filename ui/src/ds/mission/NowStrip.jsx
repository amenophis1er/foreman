import React from 'react';
import { Icon } from '../core/Icon';
import { AgentDot } from '../status/AgentDot';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard } from './QuestionCard';

/** "12m", "3h 4m", "45s" — how long a pending ask has been on the human's desk. */
export function fmtAge(since, now) {
  if (!since) return '';
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A pending ask's age line, above its card, so the wait is legible without reading the card. */
export function WaitingSince({ since, now }) {
  const age = fmtAge(since, now);
  if (!age) return null;
  return (
    <div style={{
      fontSize: 'var(--fs-xs)', color: 'var(--status-warning)',
      fontWeight: 'var(--fw-semibold)', marginBottom: 4,
    }}>waiting {age}</div>
  );
}

/**
 * The strip directly under the header: every blocking ask, answerable where
 * it stands, and otherwise one line of what the crew is doing now.
 *
 * A run once sat twelve minutes on an unanswered Write approval while the
 * header read `running` — the card was on screen, in a rail the human was
 * not watching. Needs-you is never in a side panel again: it is the first
 * thing under the header, full width, warning-coloured, and nothing sits
 * above it. Renders nothing when there is nothing pending and nothing moving.
 */
export function NowStrip({
  approvals = [], questions = [], now = Date.now(), running = false, activity,
  onAllow, onAlways, onDeny, onAnswer, style,
}) {
  const pending = approvals.length + questions.length;
  if (pending === 0 && !running) return null;
  if (pending === 0 && !activity) return null;

  const base = {
    flex: '0 0 auto', padding: 'var(--sp-2) var(--sp-3)',
    borderBottom: '1px solid var(--line)', ...style,
  };

  if (pending === 0) {
    return (
      <div role="status" style={{
        ...base, display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
        background: 'var(--bg-panel)', fontSize: 'var(--fs-sm)', minWidth: 0,
      }}>
        <Icon name="running" size={14} color="var(--status-good)" strokeWidth={2} />
        {activity.agent && <AgentDot agent={activity.agent} size="sm" />}
        <span style={{
          color: 'var(--ink-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }} title={activity.line}>{activity.line}</span>
        {activity.crew && (
          <span style={{ marginLeft: 'auto', flex: '0 0 auto', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            {activity.crew}
          </span>
        )}
      </div>
    );
  }

  return (
    <div role="region" aria-label="Needs you" style={{
      ...base, background: 'var(--brand-wash-strong)',
      borderTop: '2px solid var(--status-warning)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      maxHeight: '55vh', overflowY: 'auto',
    }}>
      <div className="pulse" style={{
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)',
        color: 'var(--status-warning)', fontWeight: 'var(--fw-semibold)',
        textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)',
      }}>
        <Icon name="needsYou" size={13} strokeWidth={2.25} />
        Needs you — {[
          approvals.length ? `${approvals.length} approval${approvals.length === 1 ? '' : 's'}` : null,
          questions.length ? `${questions.length} question${questions.length === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(', ')}
      </div>
      {approvals.map((a) => (
        <div key={a.id}>
          <WaitingSince since={a.since} now={now} />
          <ApprovalCard agent={a.agent} title={a.title}
            toolName={a.toolName} decisionReason={a.decisionReason} input={a.input}
            escapedPath={a.escapedPath}
            onAllow={() => onAllow?.(a.id)}
            onAlways={() => onAlways?.(a.id)}
            onDeny={() => onDeny?.(a.id)} />
        </div>
      ))}
      {questions.map((q) => (
        <div key={q.id}>
          <WaitingSince since={q.since} now={now} />
          <QuestionCard question={q.question} options={q.options}
            onAnswer={(answer) => onAnswer?.(q.id, answer)} />
        </div>
      ))}
    </div>
  );
}
