/**
 * The run side of crew presets: what dispatch freezes onto a record, and what
 * a report says about the verdicts it collected.
 *
 * The freeze test is the one that matters. It runs the server's own pipeline —
 * a settings blob, the overlay, the chosen ids — and then does the thing the
 * whole design exists to survive: it edits the preset afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crewPresetsFrom, type CrewPreset, type ReviewVerdict } from './crew.js';
import { frozenCrewFor, reviewReportLines } from './run-crew.js';

/** What store.readSettings() hands effectiveSettings(), for one project. */
function settings(): { global: Record<string, unknown>; project: Record<string, unknown> } {
  return {
    global: {
      crewPresets: [
        { id: 'reviewer', name: 'Reviewer', kind: 'reviewer', brief: 'Review it.', requiredForDone: true, model: 'opus' },
        { id: 'perf', name: 'Performance', kind: 'reviewer', brief: 'Look at the hot paths.', requiredForDone: false },
      ],
    },
    project: {},
  };
}

test('the freeze holds: editing a preset afterwards does not change a past run', () => {
  const s = settings();
  // What the server does at dispatch, in the order it does it.
  const presets = crewPresetsFrom(s.global, s.project);
  const run: { crew?: CrewPreset[] } = {};
  const crew = frozenCrewFor(presets, ['reviewer']);
  if (crew) run.crew = crew;
  assert.deepEqual(run.crew, [{ id: 'reviewer', name: 'Reviewer', kind: 'reviewer', brief: 'Review it.', requiredForDone: true, model: 'opus' }]);

  // Next week, the human edits the preset in Settings: a different brief, and
  // the reviewer no longer blocks a run.
  const source = (s.global.crewPresets as Array<Record<string, unknown>>)[0];
  source.brief = 'Something else entirely.';
  source.requiredForDone = false;
  source.name = 'Renamed';
  // And the list handed out after the edit is a different list, mutated too.
  for (const p of presets) { p.brief = 'mutated'; p.requiredForDone = false; }

  assert.equal(run.crew![0].brief, 'Review it.', 'the run keeps the brief it was reviewed against');
  assert.equal(run.crew![0].requiredForDone, true, 'and the gate it started under');
  assert.equal(run.crew![0].name, 'Reviewer');
});

test('crewPresetsFrom overlay: the project replaces the global list whole', () => {
  const s = settings();
  s.project.crewPresets = [{ id: 'local', name: 'House reviewer', kind: 'reviewer', brief: 'ours', requiredForDone: true }];
  assert.deepEqual(crewPresetsFrom(s.global, s.project).map((p) => p.id), ['local']);
  assert.deepEqual(crewPresetsFrom(s.global, {}).map((p) => p.id), ['reviewer', 'perf']);
  // The human emptied the project's list: no crew here, not the global one back.
  assert.deepEqual(crewPresetsFrom(s.global, { crewPresets: [] }), []);
});

test('frozenCrewFor: nothing chosen leaves the field absent', () => {
  const presets = crewPresetsFrom(settings().global, {});
  assert.equal(frozenCrewFor(presets, undefined), undefined);
  assert.equal(frozenCrewFor(presets, []), undefined);
  // Only ids nobody has a preset for: still nothing to freeze.
  assert.equal(frozenCrewFor(presets, ['ghost', '  ']), undefined);
  assert.deepEqual(frozenCrewFor(presets, ['perf', 'ghost'])?.map((p) => p.id), ['perf']);
});

const verdict = (over: Partial<ReviewVerdict>): ReviewVerdict => ({
  presetId: 'reviewer', name: 'Reviewer', pass: true, findings: '', diffHash: 'h1', workerId: 'w1', at: 1, ...over,
});
const required = (over: Partial<CrewPreset> = {}): CrewPreset =>
  ({ id: 'reviewer', name: 'Reviewer', kind: 'reviewer', brief: '', requiredForDone: true, ...over });

test('reviewReportLines: the verdicts, priced when the run was', () => {
  assert.deepEqual(reviewReportLines([required()], [verdict({ costUsd: 0.42 })]), ['reviews: Reviewer PASS · $0.42']);
  assert.deepEqual(
    reviewReportLines([required()], [verdict({ pass: false })]),
    ['reviews: Reviewer FAIL', '  Reviewer is required for this run to be done and returned FAIL.'],
  );
  // Nothing to say about a run that had no crew and collected no verdicts.
  assert.deepEqual(reviewReportLines(undefined, undefined), []);
});

test('reviewReportLines: a required reviewer that never ran is named', () => {
  assert.deepEqual(reviewReportLines([required(), { ...required({ id: 'perf', name: 'Performance' }), requiredForDone: false }], []),
    ['  Reviewer is required for this run to be done and has not reviewed it.']);
});

test('reviewReportLines: staleness is claimed only where the diff hash is known', () => {
  const crew = [required()];
  const passed = [verdict({ diffHash: 'old' })];
  // No hash: the report says what the record holds and claims nothing more.
  assert.deepEqual(reviewReportLines(crew, passed), ['reviews: Reviewer PASS']);
  assert.deepEqual(reviewReportLines(crew, passed, 'new'), [
    'reviews: Reviewer PASS',
    '  Reviewer passed an earlier version of the diff; the code changed after it.',
  ]);
  assert.deepEqual(reviewReportLines(crew, passed, 'old'), ['reviews: Reviewer PASS']);
});
