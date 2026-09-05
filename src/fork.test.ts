import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forkLabel, forkSeed } from './planner.js';

test('forkSeed: the transcript line names the run, the prompt carries brief, doc and report', () => {
  const seed = forkSeed({
    title: 'IRONOATH Strength House', mission: 'Build a single-page site…', status: 'done',
    endedAt: Date.UTC(2026, 8, 5, 15, 14), missionDoc: '# MISSION\n- [x] index.html exists', report: 'Mission complete. Built the site.',
  });
  assert.equal(seed.shown, 'Plan the next step after “IRONOATH Strength House”.');
  assert.match(seed.prompt, /Previous mission — IRONOATH Strength House \(done, /);
  assert.match(seed.prompt, /Build a single-page site…/);
  assert.match(seed.prompt, /index\.html exists/);
  assert.match(seed.prompt, /Mission complete\. Built the site\./);
  assert.match(seed.prompt, /Do not re-propose or redo/);
  assert.match(seed.prompt, /ask_user/);
});

test('forkSeed: no title falls back to the brief\'s first line; missing doc and report leave no empty sections', () => {
  const seed = forkSeed({ mission: '\n  Add a contact form\nmore detail', status: 'interrupted', missionDoc: null, report: '' });
  assert.equal(forkLabel({ mission: '\n  Add a contact form\nmore' }), 'Add a contact form');
  assert.equal(seed.shown, 'Plan the next step after “Add a contact form”.');
  assert.doesNotMatch(seed.prompt, /mission doc/);
  assert.doesNotMatch(seed.prompt, /final report/);
});

test('forkSeed: long inputs are clipped and say so', () => {
  const seed = forkSeed({ mission: 'm', status: 'done', missionDoc: 'x'.repeat(7000), report: null });
  assert.match(seed.prompt, /more characters not shown/);
  assert.ok(seed.prompt.length < 7000);
});
