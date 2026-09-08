import React, { useState } from 'react';
import { Icon } from '../core/Icon';
import { Empty } from '../core/Empty';
import { Button } from '../core/Button';
import { SectionTitle } from '../core/SectionTitle';
import { ConfirmDialog } from '../overlay/ConfirmDialog';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A cadence in words, mirroring `describeCadence` in src/schedule.ts — the
 * same sentence on the phone, in the transcript and here, because a schedule
 * the human cannot read back is one they cannot trust.
 */
export function cadenceWords(cadence) {
  if (!cadence || typeof cadence !== 'object') return 'no cadence';
  switch (cadence.kind) {
    case 'daily': return `daily ${cadence.at}`;
    case 'weekly': return `every ${DAY_NAMES[cadence.day] ?? `day ${cadence.day}`} ${cadence.at}`;
    case 'interval': {
      const m = Number(cadence.everyMinutes) || 0;
      if (m % 60 === 0) return m === 60 ? 'every hour' : `every ${m / 60} hours`;
      return `every ${m} minutes`;
    }
    case 'cron': return `cron ${cadence.expr}`;
    default: return 'no cadence';
  }
}

/**
 * The cadence as a row prints it: the same sentence as `cadenceWords`, except
 * a cron expression is set in the mono family. Proportional, `0 9 * * 1` is a
 * row of thin high asterisks nobody can count; the sheet's input already sets
 * the very same string in mono, and the two should not disagree.
 */
function CadenceLine({ cadence }) {
  if (cadence && cadence.kind === 'cron') {
    return <>cron <span style={{ fontFamily: 'var(--font-mono)' }}>{cadence.expr}</span></>;
  }
  return <>{cadenceWords(cadence)}</>;
}

/** "in 3 h" · "in 20 min" · "in 2 days" · "any moment now". Past times read as due. */
export function whenWords(at, now = Date.now()) {
  if (!at) return null;
  const ms = at - now;
  if (ms <= 0) return 'due now';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'any moment now';
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `in ${h} h`;
  const d = Math.round(h / 24);
  return `in ${d} days`;
}

/** $4.20 — cents shown, because a scheduled ceiling is argued about in cents. */
function money(n) {
  const v = Number(n) || 0;
  return `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

/**
 * Why it stopped firing by itself, in the words a person would use. Never a
 * colour alone: this sentence is the signal, the tint only seconds it.
 */
const PAUSE_WORDS = {
  failures: 'paused — two runs in a row failed',
  'monthly-cap': "paused — this month's scheduled spend would pass the ceiling",
  human: 'paused by you',
};

const OUTCOME_COLOR = {
  done: 'var(--status-good)', error: 'var(--status-critical)',
  interrupted: 'var(--status-serious)', skipped: 'var(--ink-2)',
};

function Chip({ children, color, title, icon }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 6px',
      borderRadius: 'var(--r-pill)', border: `1px solid ${color ?? 'var(--line-strong)'}`,
      color: color ?? 'var(--ink-1)', fontSize: 'var(--fs-xs)', lineHeight: '16px',
      flex: '0 0 auto', whiteSpace: 'nowrap',
    }}>
      {icon && <Icon name={icon} size={10} />}
      {children}
    </span>
  );
}

function ScheduleRow({ s, projectId, onEdit, onPause, onResume, onRunNow, onDelete }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState(false);
  const paused = !s.enabled || Boolean(s.pausedReason);
  const pausedLine = PAUSE_WORDS[s.pausedReason] ?? (paused ? 'paused — it will not fire until you resume it' : null);

  // Every control reports the server's own words: a "Run now" refused because
  // the project is already busy is a sentence, not a swallowed 409.
  const act = async (what, fn) => {
    setBusy(what); setErr('');
    try {
      const message = await fn();
      if (message) setErr(message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const next = paused ? null : whenWords(s.nextRunAt);
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: 'var(--sp-2)',
      border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
      background: paused ? 'var(--bg-inset)' : 'var(--bg-card)', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
        <span title={s.brief} style={{
          fontSize: 'var(--fs-sm)', color: paused ? 'var(--ink-1)' : 'var(--ink-0)',
          fontWeight: 'var(--fw-semibold)', overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', minWidth: 0, flex: 1,
        }}>{s.name}</span>
        {paused && <Chip icon="interrupted" color="var(--ink-2)" title={pausedLine}>paused</Chip>}
      </div>

      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', lineHeight: 'var(--lh)' }}>
        <span title={`One run costs at most ${money(s.budgetUsd)}`}><CadenceLine cadence={s.cadence} /></span>
        {next && <> · <span style={{ color: 'var(--ink-1)' }}>{next}</span></>}
        {' · '}<span>{money(s.budgetUsd)} a run</span>
      </div>

      {/* The reason in plain words, always spelled out — the tint above is a
          second signal, never the only one. */}
      {paused && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-1)' }}>{pausedLine}</div>}

      {s.lastOutcome && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
          last:{' '}
          {s.lastRunId ? (
            <a href={`#/p/${encodeURIComponent(s.projectId ?? projectId)}/r/${encodeURIComponent(s.lastRunId)}`}
              title={s.lastNote || `Open the run that ${s.lastOutcome === 'done' ? 'finished' : 'ended'} ${s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : ''}`}
              style={{ color: OUTCOME_COLOR[s.lastOutcome] ?? 'var(--ink-1)', textDecoration: 'underline' }}>
              {s.lastOutcome}
            </a>
          ) : (
            <span style={{ color: OUTCOME_COLOR[s.lastOutcome] ?? 'var(--ink-1)' }}>{s.lastOutcome}</span>
          )}
          {s.lastRunAt && <span> · {new Date(s.lastRunAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      )}

      {/* Rail width is narrow: the controls wrap rather than shrink, so a tap
          target here is never smaller than one anywhere else. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {paused ? (
          <Button variant="good" size="sm" icon="resume" disabled={Boolean(busy)}
            title={`Resume ${s.name} — it fires again on its cadence`}
            onClick={() => void act('resume', () => onResume(s))}>
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </Button>
        ) : (
          <Button variant="default" size="sm" icon="interrupted" disabled={Boolean(busy)}
            title={`Pause ${s.name} — it stops firing until you resume it`}
            onClick={() => void act('pause', () => onPause(s))}>
            {busy === 'pause' ? 'Pausing…' : 'Pause'}
          </Button>
        )}
        <Button variant="default" size="sm" icon="now" disabled={Boolean(busy)}
          title={`Start this mission now, once — ${money(s.budgetUsd)} cap. The cadence is unchanged.`}
          onClick={() => void act('run', () => onRunNow(s))}>
          {busy === 'run' ? 'Starting…' : 'Run now'}
        </Button>
        <Button variant="ghost" size="sm" icon="write" disabled={Boolean(busy)}
          title={`Edit ${s.name} — brief, cadence, budget, models`}
          onClick={() => onEdit(s)}>Edit</Button>
        <Button variant="ghost" size="sm" icon="unlink" disabled={Boolean(busy)}
          title={`Delete ${s.name} — asks first`}
          onClick={() => setConfirming(true)}>Delete</Button>
      </div>

      {err && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--status-critical)' }}>{err}</div>}

      {confirming && (
        <ConfirmDialog title={`Delete ${s.name}?`}
          body="This schedule stops existing and never fires again. The runs it already started are kept."
          confirmLabel="Delete" icon="unlink"
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); void act('delete', () => onDelete(s)); }} />
      )}
    </div>
  );
}

/**
 * The project's standing instructions, in the planning rail: what will run
 * without anyone here, when it runs next, and what it did last time. Every
 * schedule is one row deep enough to answer "is this still doing its job",
 * and resume lives here and only here — a schedule that paused itself is
 * restarted by a human looking at the reason, never by another schedule.
 */
export function SchedulesPanel({
  schedules = [], monthSpendUsd = 0, monthlyCapUsd = 0, loading, error,
  projectId, onNew, onEdit, onPause, onResume, onRunNow, onDelete, style,
}) {
  const overCap = monthlyCapUsd > 0 && monthSpendUsd >= monthlyCapUsd;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', minWidth: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
        <SectionTitle style={{ flex: '0 0 auto' }}>Schedules</SectionTitle>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" icon="add" title="Write a new standing instruction for this project"
          onClick={onNew}>New</Button>
      </div>

      {/* What the schedules have already spent this month against the ceiling
          that pauses them — the number that decides whether they keep firing. */}
      {(monthlyCapUsd > 0 || monthSpendUsd > 0) && (
        <div title="Scheduled runs only. At the ceiling, schedules pause themselves rather than spend past it."
          style={{
            fontSize: 'var(--fs-xs)', fontVariantNumeric: 'tabular-nums',
            color: overCap ? 'var(--status-serious)' : 'var(--ink-2)',
          }}>
          {/* No ceiling set is said as no ceiling, not as "$4.20 of $0". */}
          {monthlyCapUsd > 0
            ? <>{money(monthSpendUsd)} of {money(monthlyCapUsd)} this month{overCap && ' — at the ceiling'}</>
            : <>{money(monthSpendUsd)} this month · no ceiling set</>}
        </div>
      )}

      {error ? <Empty>Could not read the schedules: {error}</Empty>
        : loading && schedules.length === 0 ? <Empty>Reading the schedules…</Empty>
          : schedules.length === 0 ? (
            <Empty>Nothing standing. A schedule starts an ordinary mission here on a cadence — nightly dependency checks, a Monday morning review — and pauses itself when it fails twice or would pass the month's ceiling.</Empty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              {schedules.map((s) => (
                <ScheduleRow key={s.id} s={s} projectId={projectId}
                  onEdit={onEdit} onPause={onPause} onResume={onResume}
                  onRunNow={onRunNow} onDelete={onDelete} />
              ))}
            </div>
          )}
    </section>
  );
}
