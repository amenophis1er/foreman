import React, { useState } from 'react';
import { StatusBadge } from '../status/StatusBadge';
import { BudgetMeter } from '../status/BudgetMeter';
import { NeedsYouStrip } from '../status/NeedsYouStrip';
import { Icon } from '../core/Icon';

function fmtDate(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A linked project on the fleet grid. Whole card is the click target; `unlink` stops propagation. */
export function ProjectCard({ name, folder, instance, run, mission, costUsd, budgetUsd, activity, lastRun, pendingPermissions = 0, pendingQuestions = 0, onOpen, onUnlink, style }) {
  const [hover, setHover] = useState(false);
  const [unlinkHover, setUnlinkHover] = useState(false);
  const active = run ?? (mission ? { mission, costUsd, budgetUsd } : null);
  const needsYou = (Number(pendingPermissions) || 0) + (Number(pendingQuestions) || 0);
  return (
    <div
      role="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'var(--bg-card)', borderRadius: 'var(--r-md)', cursor: 'pointer',
        border: needsYou ? '1px solid var(--status-warning)'
          : hover ? '1px solid var(--line-strong)' : '1px solid var(--line)',
        padding: 'var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
        minHeight: 'var(--card-min-h)', transition: 'border-color var(--dur-fast) var(--ease)',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>{name}</span>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={active ? 'running' : 'idle'} /></span>
      </div>
      <div style={{
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{folder}</div>
      {instance && (
        <div title={`Missions run on ${instance}`} style={{
          fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: -4,
        }}>via {instance}</div>
      )}
      <NeedsYouStrip approvals={pendingPermissions} questions={pendingQuestions} />
      {active ? (
        <>
          <div style={{
            fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{active.mission}</div>
          <BudgetMeter spent={active.costUsd} budget={active.budgetUsd} />
          {activity && (
            <div key={activity} className="ticker" title={activity} style={{
              fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{activity}</div>
          )}
        </>
      ) : lastRun ? (
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>
            <span>Last run</span>
            <StatusBadge status={lastRun.status} />
            {lastRun.createdAt && <span>{fmtDate(lastRun.createdAt)}</span>}
            <span>${(Number(lastRun.costUsd) || 0).toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastRun.mission}</div>
        </div>
      ) : (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-2)', marginTop: 'auto' }}>
          No missions yet — open to compose one.
        </div>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onUnlink?.(); }}
        onMouseEnter={() => setUnlinkHover(true)} onMouseLeave={() => setUnlinkHover(false)}
        title="Unlink project (run history is kept)"
        style={{
          alignSelf: 'flex-end', display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer',
          color: unlinkHover ? 'var(--ink-0)' : 'var(--ink-2)', fontSize: 'var(--fs-xs)', padding: 0, font: 'inherit',
          transition: 'color var(--dur-fast) var(--ease)',
        }}
      ><Icon name="unlink" size={11} />Unlink</button>
    </div>
  );
}
