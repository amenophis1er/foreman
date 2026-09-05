import React, { useState } from 'react';
import { StatusBadge } from '../status/StatusBadge';
import { BudgetMeter, formatTokens } from '../status/BudgetMeter';
import { NeedsYouStrip } from '../status/NeedsYouStrip';
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
 * A linked project on the fleet grid. Whole card is the click target; unlink stops propagation.
 *
 * The card is read in two halves, split by a hairline: who this project is
 * (name, path, install) above, and what it is doing or last did below. The
 * lower half is bottom-aligned so a grid of cards lines its missions up on one
 * baseline regardless of how long the paths above are.
 *
 * Colour is spent only on live state. A left stripe appears when a mission is
 * running or an agent is waiting on the human; an idle card carries none, so
 * the one card that wants you is the one that stands out across a full grid.
 */
export function ProjectCard({ name, folder, instance, run, mission, title, costUsd, budgetUsd, activity, lastRun, pendingPermissions = 0, pendingQuestions = 0, plannerQuestion = false, onOpen, onUnlink, style }) {
  const [hover, setHover] = useState(false);
  const [unlinkHover, setUnlinkHover] = useState(false);
  const active = run ?? (mission ? { mission, title, costUsd, budgetUsd } : null);
  const needsYou = (Number(pendingPermissions) || 0) + (Number(pendingQuestions) || 0);

  const stripe = needsYou ? 'var(--status-warning)'
    : active ? 'var(--brand)'
    // Idle cards get the stripe only under the cursor: the same left edge that
    // carries live state also confirms what you are pointing at.
    : hover ? 'var(--line-strong)' : 'transparent';

  return (
    <article
      role="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'var(--bg-card)', borderRadius: 'var(--r-md)', cursor: 'pointer',
        border: `1px solid ${needsYou ? 'var(--status-warning)' : hover ? 'var(--line-strong)' : 'var(--line)'}`,
        // Always 3px, never 1px, so the stripe appearing costs no layout shift.
        borderLeft: `var(--accent-w) solid ${stripe}`,
        padding: 'var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
        minHeight: 'var(--card-min-h)',
        transition: 'border-color var(--dur-fast) var(--ease)',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
        <span style={{
          fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)', minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{name}</span>
        {/* Only a live mission earns a badge. "idle" on every card is a label
            that says nothing, in the position that carries the most weight. */}
        {active && <span style={{ marginLeft: 'auto', flex: '0 0 auto' }}><StatusBadge status="running" /></span>}
      </div>

      <div title={folder} style={{
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: -4,
      }}>{shortPath(folder)}</div>

      {instance && (
        <div title={`Missions run on ${instance}`} style={{
          fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: -4,
        }}>via {shortPath(instance)}</div>
      )}

      <NeedsYouStrip approvals={pendingPermissions} questions={pendingQuestions} planner={plannerQuestion} />

      <div style={{
        marginTop: 'auto', paddingTop: 'var(--sp-3)', borderTop: '1px solid var(--line)',
        display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
      }}>
        {active ? (
          <>
            {/* A named mission needs one line; an unnamed one gets two, since
                the brief is then the only thing identifying it. */}
            <div title={active.mission} style={active.title ? {
              fontSize: 'var(--fs-md)', color: 'var(--ink-0)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            } : {
              fontSize: 'var(--fs-md)', color: 'var(--ink-0)', display: '-webkit-box',
              WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{active.title || active.mission}</div>
            {/* Same rule as the project header: a run whose spend cannot be
                priced shows turns and tokens, never a dollar figure — and a
                striped track where that spend is real but unquantified. */}
            <BudgetMeter spent={active.costUsd} budget={active.budgetUsd}
              costBasis={active.costBasis} usage={active.usage} turns={active.turns} />
            {activity && (
              <div key={activity} className="ticker" title={activity} style={{
                fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{activity}</div>
            )}
          </>
        ) : lastRun ? (
          <>
            <div title={lastRun.mission} style={{
              fontSize: 'var(--fs-md)', color: 'var(--ink-0)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{lastRun.title || lastRun.mission}</div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
              fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums',
            }}>
              <StatusBadge status={lastRun.status} />
              {lastRun.createdAt && <><Dot />{fmtDate(lastRun.createdAt)}</>}
              {/* The same honesty rule as the meter: a dollar only where the
                  dollar was real. "$30.14" once stood here for a run on free
                  and unpriced models — Anthropic's table on Ollama tokens. */}
              {lastRun.costBasis === 'priced' || lastRun.costBasis === undefined
                ? <><Dot />${(Number(lastRun.costUsd) || 0).toFixed(2)}</>
                : lastRun.usage
                  ? <><Dot />{formatTokens(lastRun.usage.inputTokens + lastRun.usage.outputTokens)} tok</>
                  : null}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-2)' }}>
            No missions yet — open to compose one.
          </div>
        )}
      </div>

      {/* Unlinking is rare and mildly destructive: it appears under the cursor
          rather than sitting on every card competing with the mission text.
          The row is always laid out, so revealing it never moves anything. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', height: 16, marginTop: -2 }}>
        <button
          type="button"
          tabIndex={hover ? 0 : -1}
          onClick={(e) => { e.stopPropagation(); onUnlink?.(); }}
          onMouseEnter={() => setUnlinkHover(true)} onMouseLeave={() => setUnlinkHover(false)}
          title="Unlink project (run history is kept)"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
            cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 'var(--fs-xs)',
            color: unlinkHover ? 'var(--ink-0)' : 'var(--ink-2)',
            opacity: hover ? 1 : 0, pointerEvents: hover ? 'auto' : 'none',
            transition: 'opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
          }}
        ><Icon name="unlink" size={11} />Unlink</button>
      </div>
    </article>
  );
}
