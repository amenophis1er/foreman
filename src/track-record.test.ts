import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetAnchor, modelRecords, projectRecord, recordLine } from './track-record.js';
import type { RunMeta } from './types.js';

const run = (o: Partial<RunMeta>): RunMeta => ({
  id: 'r', folder: '/x', mission: 'm', budgetUsd: 5, status: 'done', costUsd: 1, createdAt: 0, endedAt: 10 * 60_000, workers: [], costBasis: 'priced', ...o,
} as RunMeta);

test('modelRecords: directors by outcome with median cost and minutes; workers by finish', () => {
  const runs = [
    run({ directorModel: 'sonnet', workerModel: 'gemma4:12b', costUsd: 0.78, endedAt: 18 * 60_000, workers: [{ id: 'w1', status: 'done', costUsd: 0, task: '' }, { id: 'w2', status: 'error', costUsd: 0, task: '' }] }),
    run({ directorModel: 'sonnet', costUsd: 0.22, endedAt: 1 * 60_000 }),
    run({ directorModel: 'sonnet', status: 'interrupted', costUsd: 4.96 }),
    run({ directorModel: 'ornith-1.5:9b', workerModel: 'ornith-1.5:9b', status: 'interrupted', costBasis: 'free', costUsd: 0, workers: [{ id: 'w1', status: 'done', costUsd: 0, task: '' }, { id: 'w2', status: 'done', costUsd: 0, task: '' }, { id: 'w3', status: 'error', costUsd: 0, task: '' }] }),
    run({ directorModel: 'opus', status: 'running' }),
  ] as RunMeta[];
  const m = modelRecords(runs);
  const sonnet = m.get('sonnet')!;
  assert.equal(sonnet.runs, 3); assert.equal(sonnet.done, 2); assert.equal(sonnet.interrupted, 1);
  assert.equal(sonnet.medianCostUsd, 0.5); assert.equal(sonnet.medianMinutes, 10);
  assert.equal(m.get('gemma4:12b')!.workers, 2); assert.equal(m.get('gemma4:12b')!.workersDone, 1);
  const ornith = m.get('ornith-1.5:9b')!;
  assert.equal(ornith.runs, 1); assert.equal(ornith.done, 0); assert.equal(ornith.workers, 3); assert.equal(ornith.workersFailed, 1);
  assert.equal(ornith.medianCostUsd, undefined);
  assert.equal(m.has('opus'), false, 'a running run is not a record yet');
});

test('recordLine says it in one line, or nothing', () => {
  const m = modelRecords([run({ directorModel: 'sonnet', workerModel: 'gemma4:12b', costUsd: 0.78, endedAt: 18 * 60_000, workers: [{ id: 'w1', status: 'done', costUsd: 0, task: '' }, { id: 'w2', status: 'error', costUsd: 0, task: '' }] })] as RunMeta[]);
  assert.equal(recordLine(m.get('sonnet')), 'here: director 1/1 done (~$0.78, ~18 min)');
  assert.equal(recordLine(m.get('gemma4:12b')), 'here: workers 1/2 finished');
  assert.equal(recordLine(undefined), undefined);
});

test('projectRecord and budgetAnchor: quartiles, cap hits, and silence when there is too little', () => {
  const few = projectRecord([run({ costUsd: 2 })]);
  assert.equal(budgetAnchor(few, few, 'P'), '');
  const runs = [1, 2, 3, 4, 4.9].map((c) => run({ costUsd: c, budgetUsd: 5 }));
  const p = projectRecord(runs);
  assert.equal(p.done, 5); assert.equal(p.medianCostUsd, 3); assert.equal(p.costLowUsd, 2); assert.equal(p.costHighUsd, 4); assert.equal(p.capHits, 1);
  const a = budgetAnchor(p, projectRecord([...runs, run({ costUsd: 10, budgetUsd: 20 })]), 'Tick');
  assert.match(a, /In "Tick", finished missions cost \$2\.0–\$4\.0 \(median \$3\.0\), ~10 min, over 5 finished missions; 1 ended within 5% of the cap\./);
  assert.match(a, /Across the fleet: /);
  assert.match(a, /anchor above it, not on it/);
});
