import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ModalHeader, ModalFooter } from '../overlay/Modal';
import { Button } from '../core/Button';
import { Tabs } from '../core/Tabs';
import { Field } from '../forms/Field';
import { TextInput } from '../forms/TextInput';
import { Textarea } from '../forms/Textarea';
import { Switch } from '../forms/Switch';
import { ModelSelect } from '../forms/ModelSelect';
import { Icon } from '../core/Icon';
import { cadenceWords } from './SchedulesPanel';

const DAYS = [
  { day: 1, short: 'Mon' }, { day: 2, short: 'Tue' }, { day: 3, short: 'Wed' },
  { day: 4, short: 'Thu' }, { day: 5, short: 'Fri' }, { day: 6, short: 'Sat' },
  { day: 0, short: 'Sun' },
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The four shapes a cadence can take, as the picker holds them: one draft per
 *  kind, so switching back and forth never loses what was typed. */
function draftFrom(cadence) {
  const d = { kind: 'daily', at: '09:00', day: 1, hours: 6, expr: '0 9 * * 1' };
  if (!cadence) return d;
  if (cadence.kind === 'daily') return { ...d, kind: 'daily', at: cadence.at };
  if (cadence.kind === 'weekly') return { ...d, kind: 'weekly', at: cadence.at, day: cadence.day };
  if (cadence.kind === 'interval') return { ...d, kind: 'interval', hours: Math.max(1, Math.round((cadence.everyMinutes ?? 60) / 60)) };
  if (cadence.kind === 'cron') return { ...d, kind: 'cron', expr: cadence.expr };
  return d;
}

/** The draft as the server's `Cadence`, or null while it is not yet valid. */
function cadenceOf(d) {
  if (d.kind === 'daily') return HHMM.test(d.at) ? { kind: 'daily', at: d.at } : null;
  if (d.kind === 'weekly') return HHMM.test(d.at) ? { kind: 'weekly', day: d.day, at: d.at } : null;
  if (d.kind === 'interval') {
    const h = Number(d.hours);
    // Never below an hour: the server refuses it, and a mission that starts
    // every few minutes is a runaway, not a schedule.
    return Number.isFinite(h) && h >= 1 ? { kind: 'interval', everyMinutes: Math.round(h) * 60 } : null;
  }
  if (d.kind === 'cron') return d.expr.trim() ? { kind: 'cron', expr: d.expr.trim() } : null;
  return null;
}

function whenLine(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Write a standing instruction: what to do, how often, how much one run may
 * cost. The three times it would next fire are shown live under the picker —
 * a cadence is only trustworthy once you have seen what it means, and a cron
 * expression the server cannot read says so here rather than at 3am.
 */
export function ScheduleSheet({
  schedule, models, modelsLoading, modelsNote, modelsInheritNote,
  defaultBudgetUsd = 6, onPreview, onSave, onClose,
}) {
  const editing = Boolean(schedule);
  const [name, setName] = useState(schedule?.name ?? '');
  const [brief, setBrief] = useState(schedule?.brief ?? '');
  const [draft, setDraft] = useState(() => draftFrom(schedule?.cadence));
  const [budget, setBudget] = useState(schedule?.budgetUsd ?? defaultBudgetUsd);
  const [directorModel, setDirectorModel] = useState(schedule?.directorModel ?? '');
  const [workerModel, setWorkerModel] = useState(schedule?.workerModel ?? '');
  const [directorProviderId, setDirectorProviderId] = useState(schedule?.directorProviderId);
  const [workerProviderId, setWorkerProviderId] = useState(schedule?.workerProviderId);
  const [enabled, setEnabled] = useState(schedule ? schedule.enabled !== false : true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState({ next: [], error: '', loading: false });

  const cadence = useMemo(() => cadenceOf(draft), [draft]);
  const cadenceKey = cadence ? JSON.stringify(cadence) : '';

  // Debounced: a cron expression is typed one character at a time, and every
  // half-written one would otherwise be asked about.
  useEffect(() => {
    if (!cadence || !onPreview) { setPreview({ next: [], error: '', loading: false }); return; }
    let cancelled = false;
    // Cleared, not kept: the wording above updates the moment the cadence
    // does, and yesterday's three times under today's sentence is a lie.
    setPreview({ next: [], error: '', loading: true });
    const t = setTimeout(() => {
      Promise.resolve(onPreview(cadence)).then((r) => {
        if (cancelled) return;
        setPreview({ next: r?.next ?? [], error: r?.error ?? '', loading: false });
      }).catch((e) => {
        if (!cancelled) setPreview({ next: [], error: e instanceof Error ? e.message : String(e), loading: false });
      });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [cadenceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The preview is the server's own reading of the cadence, so its refusal is
  // the answer a save would get: offering Create over it invites a bounce.
  // Only a refusal that came back counts — an in-flight preview leaves this
  // false, because a slow answer must never hold up a cadence that is fine.
  const refused = Boolean(cadence && preview.error);

  const problem = !name.trim() ? 'Give it a name.'
    : !brief.trim() ? 'Say what the mission should do.'
      : !cadence ? (draft.kind === 'interval' ? 'Hours must be a whole number, one or more.'
        : draft.kind === 'cron' ? 'Write a five-field cron expression.'
          : 'Time must read as HH:MM, like 07:30.')
        : !(Number(budget) > 0) ? 'A run needs a budget cap.' : '';

  const save = async () => {
    if (problem) { setError(problem); return; }
    setSaving(true); setError('');
    try {
      const message = await onSave({
        name: name.trim(), brief: brief.trim(), cadence, budgetUsd: Number(budget),
        directorModel: directorModel || undefined, workerModel: workerModel || undefined,
        directorProviderId: directorProviderId || undefined,
        workerProviderId: workerProviderId || undefined,
        enabled,
      });
      if (message) setError(message); else onClose?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal width={640} onClose={saving ? undefined : onClose}>
      <ModalHeader>
        <div style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', color: 'var(--ink-0)' }}>
          {editing ? 'Edit schedule' : 'New schedule'}
        </div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginTop: 2 }}>
          A standing instruction: Foreman starts this mission on its own, on this cadence, with nobody watching.
        </div>
      </ModalHeader>

      <div style={{ padding: 'var(--sp-3)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <Field layout="stacked" label="Name" hint="What it is called in the rail and in the notification.">
          <TextInput value={name} onChange={setName} placeholder="Nightly dependency check" autoFocus />
        </Field>

        <Field layout="stacked" label="Brief" hint="The mission, written as you would write it in the composer.">
          {/* The answer box, given the height a mission brief needs — the
              mission size (180px min) would push the cadence preview out of
              a 70vh sheet on a laptop. */}
          <Textarea value={brief} onChange={setBrief} size="answer" style={{ height: 120, minHeight: 72 }}
            placeholder="Check for outdated dependencies, open a branch with the safe upgrades, run the tests." />
        </Field>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <Tabs size="sm" value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} tabs={[
            { value: 'daily', label: 'Daily' },
            { value: 'weekly', label: 'Weekly' },
            { value: 'interval', label: 'Every N hours' },
            { value: 'cron', label: 'Cron' },
          ]} />

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
            {(draft.kind === 'daily' || draft.kind === 'weekly') && (
              <Field layout="stacked" label="At" hint="24-hour clock, this machine's time zone.">
                <TextInput value={draft.at} onChange={(at) => setDraft({ ...draft, at })} width={96} mono placeholder="07:30" />
              </Field>
            )}
            {draft.kind === 'weekly' && (
              <Field layout="stacked" label="Day" hint="Which day of the week it fires.">
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {DAYS.map((d) => (
                    <Button key={d.day} size="sm" variant={draft.day === d.day ? 'primary' : 'default'}
                      title={`Every ${d.short}`} onClick={() => setDraft({ ...draft, day: d.day })}>
                      {d.short}
                    </Button>
                  ))}
                </div>
              </Field>
            )}
            {draft.kind === 'interval' && (
              <Field layout="stacked" label="Every" hint="Hours between runs. One hour is the shortest Foreman allows.">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <TextInput type="number" min={1} step={1} width={96} value={draft.hours}
                    onChange={(hours) => setDraft({ ...draft, hours })} />
                  <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-2)' }}>hours</span>
                </span>
              </Field>
            )}
            {draft.kind === 'cron' && (
              <Field layout="stacked" label="Expression" hint="Five fields: minute hour day-of-month month day-of-week.">
                <TextInput value={draft.expr} mono onChange={(expr) => setDraft({ ...draft, expr })} placeholder="0 9 * * 1" />
              </Field>
            )}
          </div>

          {/* What the cadence actually means, from the server that will run it
              — including its refusal, which is the only honest answer to a
              cron expression nobody can read. */}
          <div style={{
            padding: 'var(--sp-2)', background: 'var(--bg-inset)', border: '1px solid var(--line)',
            borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
          }}>
            {preview.error ? (
              <span style={{ color: 'var(--status-critical)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="warning" size={11} />{preview.error}
              </span>
            ) : !cadence ? (
              <span>Next three runs appear once the cadence reads.</span>
            ) : preview.loading && preview.next.length === 0 ? (
              <span>Working out the next three runs…</span>
            ) : preview.next.length === 0 ? (
              <span>Nothing scheduled from this cadence.</span>
            ) : (
              <>
                <div style={{ color: 'var(--ink-1)' }}>{cadenceWords(cadence)} — next three runs:</div>
                <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {preview.next.slice(0, 3).map((t) => <div key={t}>{whenLine(t)}</div>)}
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <Field layout="stacked" label="Budget cap" hint="Per run, not per month. The run halts here.">
            <TextInput type="number" min={1} step={1} width={96} prefix="$" value={budget} onChange={setBudget} />
          </Field>
          <Field layout="stacked" label="Director" hint="Plans, delegates, verifies.">
            <ModelSelect value={directorModel} models={models} loading={modelsLoading}
              note={modelsNote} inheritNote={modelsInheritNote}
              onChange={(id, m) => { setDirectorModel(id); setDirectorProviderId(m?.providerId); }} />
          </Field>
          <Field layout="stacked" label="Workers" hint="Implement. Cheaper models cut cost.">
            <ModelSelect value={workerModel} models={models} loading={modelsLoading}
              note={modelsNote} inheritNote={modelsInheritNote}
              onChange={(id, m) => { setWorkerModel(id); setWorkerProviderId(m?.providerId); }} />
          </Field>
        </div>
      </div>

      <ModalFooter>
        {/* Whether any of this ever fires is decided here, beside Cancel and
            Create, and never in the scrolling tail: on a short screen the body
            scrolls and a switch down there is invisible until you find out you
            can scroll. In the footer it is on screen at every height. */}
        <span title="Off keeps the schedule but stops it firing."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
          <Switch checked={enabled} onChange={setEnabled} disabled={saving} size="sm" label="Enabled" />
          <span style={{ fontSize: 'var(--fs-xs)', color: enabled ? 'var(--ink-1)' : 'var(--ink-2)' }}>
            {enabled ? 'Enabled' : 'Paused'}
          </span>
        </span>
        {(error || problem) && (
          <span title={error || problem} style={{
            fontSize: 'var(--fs-xs)', color: error ? 'var(--status-critical)' : 'var(--ink-2)',
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {error || problem}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }} />
        <Button variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
        {/* A second line, not a replacement: the server validates again. */}
        <Button variant="primary" disabled={saving || Boolean(problem) || refused}
          title={problem
            || (refused ? `The server will not take this cadence: ${preview.error}` : '')
            || (editing ? 'Save the changes' : 'Create this schedule')}
          onClick={() => void save()}>
          {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
