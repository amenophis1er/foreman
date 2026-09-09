import React, { useState } from 'react';
import { StatusBadge } from '../status/StatusBadge';
import { formatTokens } from '../status/BudgetMeter';
import { Icon } from '../core/Icon';
import { shortPath } from '../core/path';

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Meta row separator — a dot, so date and cost never run together. */
function Dot() {
  return <span style={{ color: 'var(--ink-2)', opacity: 0.6 }}>·</span>;
}

/**
 * A project with nothing running: its last outcome, compact.
 *
 * The cost rule is the one thing here that must not regress. "$30.14" once
 * stood on this tile for a run on free and unpriced models — Anthropic's
 * price table applied to Ollama tokens. A dollar appears only when the
 * server says the basis is `priced`; tokens when the usage is known;
 * nothing otherwise. An absent basis is *not* priced.
 */
export function OutcomeTile({ name, folder, lastRun, onOpen, onUnlink, style }) {
  const [hover, setHover] = useState(false);
  const [unlinkHover, setUnlinkHover] = useState(false);
  const tokens = lastRun?.usage
    ? lastRun.usage.inputTokens + lastRun.usage.outputTokens
    : null;
  // Every reviewer this run required, and got. The server decides it and
  // sends names: the tile has no diff to hash, and it must not invent a rule
  // of its own that could disagree with the run header's.
  const reviewers = lastRun?.status === 'done' ? (lastRun.reviewedBy ?? []) : [];
  return (
    <article role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(); } }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        background: 'var(--bg-card)', borderRadius: 'var(--r-md)', cursor: 'pointer',
        border: `1px solid ${hover ? 'var(--line-strong)' : 'var(--line)'}`,
        padding: 'var(--sp-3) var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
        transition: 'border-color var(--dur-fast) var(--ease)',
        ...style,
      }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)', minWidth: 0 }}>
        <span style={{
          fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', color: 'var(--ink-0)', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{name}</span>
        <span title={folder} style={{
          fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 'auto',
        }}>{shortPath(folder)}</span>
      </div>

      {lastRun ? (
        <>
          <div title={lastRun.mission} style={{
            fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{lastRun.title || lastRun.mission}</div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums',
          }}>
            <StatusBadge status={lastRun.status} />
            {/* Reviewed: an eye that checked out. Two icons the set already
                has, tucked together — no new glyph, no icon dependency, and
                it sits beside the badge because it qualifies the outcome.
                It wears meta ink, not the badge's green, and comes after a
                dot like every other fact on this row: abutting the pill in
                the pill's own colour, at tile scale it read as a smudge on
                the pill rather than a second thing being said. The pair is
                one image with one name — the tooltip alone reached neither
                keyboard nor touch. */}
            {reviewers.length > 0 && (
              <>
                <Dot />
                <span role="img" aria-label={`Reviewed by ${reviewers.join(', ')}`}
                  title={`Reviewed by ${reviewers.join(', ')} — ${reviewers.length === 1 ? 'its' : 'their'} PASS on this run's final diff is what let Foreman record it done`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 1, color: 'var(--ink-2)' }}>
                  <Icon name="preview" size={12} />
                  <Icon name="check" size={10} strokeWidth={2.5} />
                </span>
              </>
            )}
            {lastRun.createdAt && <><Dot />{fmtDate(lastRun.createdAt)}</>}
            {lastRun.costBasis === 'priced'
              ? <><Dot />${(Number(lastRun.costUsd) || 0).toFixed(2)}</>
              : tokens !== null
                ? <><Dot />{formatTokens(tokens)} tok</>
                : null}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-2)' }}>
          No missions yet — open to compose one.
        </div>
      )}

      {/* Unlinking is rare and mildly destructive: revealed under the cursor,
          in a row that is always laid out so nothing moves when it appears. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', height: 14, marginTop: -2 }}>
        <button type="button" tabIndex={hover ? 0 : -1}
          onClick={(e) => { e.stopPropagation(); onUnlink?.(); }}
          onMouseEnter={() => setUnlinkHover(true)} onMouseLeave={() => setUnlinkHover(false)}
          title="Unlink project (run history is kept)"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
            cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 'var(--fs-xs)',
            color: unlinkHover ? 'var(--ink-0)' : 'var(--ink-2)',
            opacity: hover ? 1 : 0, pointerEvents: hover ? 'auto' : 'none',
            transition: 'opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
          }}><Icon name="unlink" size={11} />Unlink</button>
      </div>
    </article>
  );
}
