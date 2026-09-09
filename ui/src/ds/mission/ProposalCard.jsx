import React, { useState } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { Field } from '../forms/Field';
import { TextInput } from '../forms/TextInput';
import { ModelSelect } from '../forms/ModelSelect';
import { Switch } from '../forms/Switch';
import { Banner } from '../status/Banner';
import { CrewToggles } from './Composer';

/**
 * The handoff: a mission the planner drafted, for the human to read, edit and
 * start. This card *is* the moment of commitment — the point where a
 * conversation that has only been reading becomes a crew that will write. So
 * it states what will be done, how completion will be judged, and what it may
 * cost, and it never starts anything on its own.
 *
 * It carries every lever the composer has — budget, director, workers,
 * browser, crew — because a mission committed without the browser it needs, or
 * on a model nobody chose, is the mistake that costs an hour to notice. The
 * planner pre-sets `browser` when the DONE WHEN criteria need one, and may
 * suggest a `crew`; the human can still flip either. Models start at "inherit"
 * (the project's Settings), the same default the composer uses.
 *
 * The brief and the budget are editable in place. To change the shape, say so
 * and let the planner redraft.
 */
export function ProposalCard({
  mission, doneWhen = [], budgetUsd = 5, rationale, browser = false,
  directorModel: suggestedDirector = '', workerModel: suggestedWorker = '',
  directorProviderId: suggestedDirectorProvider, workerProviderId: suggestedWorkerProvider,
  modelRationale,
  models, modelsLoading, modelsNote, modelsInheritNote,
  crewPresets = [], crew: suggestedCrew, onCrewChange,
  busy, error, errorAction, onStart, onDismiss, style,
}) {
  const [brief, setBrief] = useState(mission);
  const [budget, setBudget] = useState(budgetUsd);
  const [browserTools, setBrowserTools] = useState(Boolean(browser));
  // Pre-selected from the planner's recommendation when it made one — it has
  // read the criteria and knows what the work is mostly made of. '' inherits.
  const [directorModel, setDirectorModel] = useState(suggestedDirector || '');
  const [workerModel, setWorkerModel] = useState(suggestedWorker || '');
  const [directorProviderId, setDirectorProviderId] = useState(suggestedDirectorProvider);
  const [workerProviderId, setWorkerProviderId] = useState(suggestedWorkerProvider);
  // Same rule as the models: the planner may suggest a crew, but the toggles
  // decide. It only sets where they start.
  const [crew, setCrew] = useState(suggestedCrew ?? []);
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

      {/* The planner's reason for its model picks, above the pickers it
          filled: a suggestion with a reason reads as advice; a picker that
          arrived already set reads as a setting nobody chose. */}
      {modelRationale && (suggestedDirector || suggestedWorker) && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
          <Icon name="model" size={12} />
          <span><span style={{ color: 'var(--ink-1)' }}>Suggested models —</span> {modelRationale}</span>
        </div>
      )}
      {/* The same row the composer shows, in the same order, so the two ways
          of starting a mission never disagree about what can be chosen. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
        <Field layout="stacked" label="Budget cap" hint="Hard stop; the run halts here.">
          <TextInput type="number" prefix="$" min={0} step={1} width={96}
            value={budget} onChange={setBudget} />
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
        <Field label="Browser"
          hint={browser
            ? 'The planner judged the criteria need a browser, so it starts on.'
            : 'Headless Playwright for the agents — navigate, click, screenshot. Non-local URLs still ask you.'}>
          <Switch checked={browserTools} onChange={setBrowserTools} label={browserTools ? 'on' : 'off'} />
        </Field>
      </div>

      <CrewToggles presets={crewPresets} value={crew}
        onChange={(ids) => { setCrew(ids); onCrewChange?.(ids); }} />

      {error && (
        <Banner tone="error" inline>
          {error}
          {errorAction && (
            <button type="button" onClick={errorAction.onClick} disabled={busy}
              style={{
                marginLeft: 8, background: 'none', border: 0, padding: 0, font: 'inherit',
                color: 'inherit', textDecoration: 'underline', cursor: busy ? 'default' : 'pointer',
              }}>{errorAction.label}</button>
          )}
        </Banner>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
        <Button variant="ghost" onClick={onDismiss} disabled={busy}>Not this one</Button>
        <Button variant="primary" icon="orchestration" disabled={busy || !brief.trim()}
          title="Starts the mission: a director plans it and workers do the work"
          onClick={() => onStart?.({
            mission: brief.trim(), budget: Number(budget) || budgetUsd,
            directorModel, workerModel, directorProviderId, workerProviderId, browserTools,
            crew: crewPresets.filter((p) => crew.includes(p.id)).map((p) => p.id),
          })}>
          {busy ? 'Starting…' : 'Start mission'}
        </Button>
      </div>
    </section>
  );
}
