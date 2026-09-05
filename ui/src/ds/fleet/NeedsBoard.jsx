import React, { useEffect, useState } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';

/** 3 minutes → "3m", 95 minutes → "1h 35m", two days → "2d". */
export function formatWait(sinceMs, now = Date.now()) {
  const s = Math.max(0, Math.round((now - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const KIND_LABEL = {
  permission: 'approval',
  question: 'director asks',
  planner: 'the planner is asking',
  summary: 'needs you',
};

/** Plural helper for the count-only fallback line. */
function plural(n, word) { return `${n} ${word}${n > 1 ? 's' : ''}`; }

/**
 * One pending ask, answerable where it is shown.
 *
 * Busy and error state live here, per strip: two projects can be waiting at
 * once, and a failed Allow on one must not grey out the other. The handlers
 * resolve to an error string or null, the shape `useChat().answer` already
 * returns, so the strip can print "already answered" when the ask timed out
 * between the poll and the click — a real case, since the board is refreshed
 * every few seconds and the server auto-resolves stale asks.
 */
function NeedStrip({ item, onPermission, onAnswer, onPlanner, onOpen }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');

  // A new ask under the same key (rare: ids are unique) or a refresh that
  // replaces the item resets the local state so nothing stale sticks.
  useEffect(() => { setBusy(false); setError(''); setTyping(false); setText(''); }, [item.id]);

  const run = async (fn) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const err = await fn();
      if (err) { setError(err); setBusy(false); }
      // On success we stay disabled until the refresh removes the strip.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const answer = (choice) => {
    if (item.kind === 'planner') return run(() => onPlanner(item, choice));
    return run(() => onAnswer(item, choice));
  };
  const sendTyped = () => {
    const t = text.trim();
    if (t) void answer(t);
  };

  const hasOptions = Array.isArray(item.options) && item.options.length > 0;
  const answerable = item.kind === 'question' || item.kind === 'planner';
  // A question with no options is answered by typing — no need for a
  // reveal step, the input is the only control there is.
  const showInput = answerable && (typing || !hasOptions);

  return (
    <div className={busy ? undefined : 'pulse'} style={{
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      padding: 'var(--sp-3) var(--sp-4)',
      background: 'var(--brand-wash-strong)',
      border: '1px solid var(--status-warning)',
      borderLeft: 'var(--accent-w) solid var(--status-warning)',
      borderRadius: 'var(--r-md)',
      opacity: busy ? 0.7 : 1,
      transition: 'opacity var(--dur-fast) var(--ease)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)', minWidth: 0, fontSize: 'var(--fs-sm)' }}>
        <Icon name={item.kind === 'permission' ? 'approval' : item.kind === 'summary' ? 'needsYou' : 'question'}
          size={14} strokeWidth={2} color="var(--status-warning)" style={{ alignSelf: 'center', flex: '0 0 auto' }} />
        <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--ink-0)', flex: '0 0 auto' }}>{item.projectName}</span>
        <span style={{ color: 'var(--status-warning)', fontWeight: 'var(--fw-medium)', flex: '0 0 auto' }}>
          {KIND_LABEL[item.kind] ?? item.kind}
        </span>
        <span title={item.text} style={{
          color: 'var(--ink-0)', minWidth: 0, flex: '1 1 auto',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{item.text}</span>
        {typeof item.since === 'number' && (
          <span style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-xs)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
            waiting {formatWait(item.since)}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {item.kind === 'permission' && (
          <>
            {/* Allow and Deny only. "Always (run)" opens a tool or a path for
                the rest of the run, and that grant belongs on the screen that
                shows what it opens — the approval card with the payload. */}
            <Button size="sm" variant="good" disabled={busy}
              onClick={() => void run(() => onPermission(item, 'allow'))}>Allow</Button>
            <Button size="sm" variant="danger" disabled={busy}
              onClick={() => void run(() => onPermission(item, 'deny'))}>Deny</Button>
          </>
        )}

        {answerable && hasOptions && item.options.map((o, i) => (
          <button key={o} type="button" disabled={busy}
            onClick={() => void answer(o)}
            title={i === 0 ? 'Recommended' : undefined}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 'var(--r-sm)', cursor: busy ? 'default' : 'pointer',
              font: 'inherit', fontSize: 'var(--fs-sm)', textAlign: 'left', maxWidth: 360,
              background: 'var(--bg-card)', border: '1px solid var(--line-strong)', color: 'var(--ink-0)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
            {i === 0 && <span style={{ color: 'var(--status-warning)', fontSize: 'var(--fs-xs)' }}>★</span>}
            {o}
          </button>
        ))}

        {answerable && hasOptions && !typing && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setTyping(true)}>type…</Button>
        )}

        {showInput && (
          <form onSubmit={(e) => { e.preventDefault(); sendTyped(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 16rem', minWidth: 0 }}>
            <input autoFocus={typing} value={text} disabled={busy}
              placeholder={item.kind === 'planner' ? 'Answer the planner…' : 'Answer the director…'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && hasOptions) { setTyping(false); setText(''); } }}
              style={{
                flex: '1 1 auto', minWidth: 0, font: 'inherit', fontSize: 'var(--fs-sm)',
                padding: '4px 8px', borderRadius: 'var(--r-sm)',
                background: 'var(--bg-card)', border: '1px solid var(--line-strong)', color: 'var(--ink-0)',
                outline: 'none',
              }} />
            <Button size="sm" type="submit" icon="send" disabled={busy || !text.trim()}>Send</Button>
          </form>
        )}

        <span style={{ marginLeft: 'auto', flex: '0 0 auto' }}>
          <Button size="sm" variant="ghost" onClick={() => onOpen?.(item.projectId)}
            title="Open the project for the full context">open</Button>
        </span>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-danger)' }}>
          <Icon name="caution" size={12} strokeWidth={2} />{error}
        </div>
      )}
    </div>
  );
}

/**
 * The first thing on the board: every pending ask across the fleet, one strip
 * each, answerable in place. Renders nothing when there is nothing to answer.
 *
 * Items arrive already ordered by the caller (project urgency, then age); the
 * board does not sort. A `summary` item is the count-only fallback for a
 * server that has not yet sent `needs` — it can be opened, not answered.
 */
export function NeedsBoard({ items = [], onPermission, onAnswer, onPlanner, onOpen, style }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', ...style }}>
      {items.map((it) => (
        <NeedStrip key={`${it.projectId}:${it.kind}:${it.id ?? ''}`} item={it}
          onPermission={onPermission} onAnswer={onAnswer} onPlanner={onPlanner} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** Builds the count-only fallback line: "2 approvals, 1 question". */
export function summaryText({ approvals = 0, questions = 0, planner = false }) {
  const parts = [];
  if (approvals > 0) parts.push(plural(approvals, 'approval'));
  const runQuestions = planner ? questions - 1 : questions;
  if (runQuestions > 0) parts.push(plural(runQuestions, 'question'));
  if (planner) parts.push('the planner is asking');
  return parts.join(', ');
}
