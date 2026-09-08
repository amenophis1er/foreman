import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Schedule } from './types.js';
import {
  DEFAULT_SCHEDULED_MONTHLY_CAP_USD,
  monthlyScheduledSpend,
  isFailedOutcome,
  afterRunOutcome,
  decideTicks,
  type TickAction,
} from './schedule-guards.js';

/** Local time, because months and cadences are both local here. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min, 0, 0);

/** A run row as monthlyScheduledSpend sees one. */
function run(over: Partial<{ projectId: string; scheduleId: string; createdAt: number; costUsd: number }> = {}) {
  return { projectId: 'p1', scheduleId: 's1', createdAt: at(2026, 4, 10, 3).getTime(), costUsd: 1, ...over };
}

/** A schedule, due at `nextRunAt`, with only the fields the ticker reads. */
function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1', projectId: 'p1', name: 'nightly', brief: 'tidy up',
    cadence: { kind: 'daily', at: '03:00' },
    budgetUsd: 5,
    enabled: true,
    createdAt: at(2026, 0, 1).getTime(),
    nextRunAt: at(2026, 4, 10, 3).getTime(),
    consecutiveFailures: 0,
    pausedReason: null,
    ...over,
  };
}

/** decideTicks with the plumbing filled in; NOW is 2026-05-10 09:00 local. */
const NOW = at(2026, 4, 10, 9);
function decide(schedules: Schedule[], over: Partial<Parameters<typeof decideTicks>[0]> = {}): TickAction[] {
  return decideTicks({
    schedules,
    now: NOW,
    busyProjectIds: [],
    monthSpend: {},
    capFor: () => DEFAULT_SCHEDULED_MONTHLY_CAP_USD,
    ...over,
  });
}

test('monthlyScheduledSpend: only this project\'s scheduled runs, only this month', () => {
  const now = at(2026, 4, 20, 12);
  const runs = [
    run({ costUsd: 3 }),
    run({ costUsd: 4, scheduleId: 's2' }),
    // A hand-started mission spends the human's attention, not the allowance.
    run({ costUsd: 100, scheduleId: undefined }),
    // Another project's schedule, and a run with no project at all.
    run({ costUsd: 100, projectId: 'p2' }),
    run({ costUsd: 100, projectId: undefined }),
    // Last month, and next month.
    run({ costUsd: 100, createdAt: at(2026, 3, 30, 23, 59).getTime() }),
    run({ costUsd: 100, createdAt: at(2026, 5, 1, 0, 0).getTime() }),
  ];
  assert.equal(monthlyScheduledSpend(runs, 'p1', now), 7);
  assert.equal(monthlyScheduledSpend(runs, 'p2', now), 100);
  assert.equal(monthlyScheduledSpend([], 'p1', now), 0);
});

test('monthlyScheduledSpend: the month boundary is local midnight, and December rolls to January', () => {
  // The last minute of April and the first of May are different months even
  // though they are a minute apart.
  const april = [run({ costUsd: 2, createdAt: at(2026, 3, 30, 23, 59).getTime() })];
  const may = [run({ costUsd: 2, createdAt: at(2026, 4, 1, 0, 0).getTime() })];
  assert.equal(monthlyScheduledSpend(april, 'p1', at(2026, 3, 15)), 2);
  assert.equal(monthlyScheduledSpend(april, 'p1', at(2026, 4, 15)), 0);
  assert.equal(monthlyScheduledSpend(may, 'p1', at(2026, 4, 15)), 2);
  assert.equal(monthlyScheduledSpend(may, 'p1', at(2026, 3, 15)), 0);

  // December 2026 and January 2027 are both "month 0-ish" traps: the same
  // month number, or the same year, is not the same month.
  const dec = run({ costUsd: 6, createdAt: at(2026, 11, 31, 23, 30).getTime() });
  const jan = run({ costUsd: 9, createdAt: at(2027, 0, 1, 0, 30).getTime() });
  assert.equal(monthlyScheduledSpend([dec, jan], 'p1', at(2026, 11, 31, 23, 59)), 6);
  assert.equal(monthlyScheduledSpend([dec, jan], 'p1', at(2027, 0, 2)), 9);
  // Same month number, previous year: not this month.
  assert.equal(monthlyScheduledSpend([run({ costUsd: 5, createdAt: at(2025, 4, 10).getTime() })], 'p1', at(2026, 4, 10)), 0);
});

test('isFailedOutcome: errors and capped interruptions, not restarts', () => {
  assert.equal(isFailedOutcome({ status: 'error' }), true);
  assert.equal(isFailedOutcome({ status: 'interrupted', stopReason: 'budget' }), true);
  assert.equal(isFailedOutcome({ status: 'interrupted', stopReason: 'turns' }), true);
  assert.equal(isFailedOutcome({ status: 'interrupted', stopReason: 'time' }), true);
  assert.equal(isFailedOutcome({ status: 'interrupted', stopReason: 'tokens' }), true);
  // A sweep on startup leaves no stopReason: the server restarted, the
  // schedule did nothing wrong.
  assert.equal(isFailedOutcome({ status: 'interrupted' }), false);
  assert.equal(isFailedOutcome({ status: 'interrupted', stopReason: null }), false);
  assert.equal(isFailedOutcome({ status: 'done' }), false);
  assert.equal(isFailedOutcome({ status: 'running' }), false);
});

test('afterRunOutcome: two failures in a row pause, a success resets', () => {
  const fresh = { consecutiveFailures: 0, pausedReason: null } as const;
  const once = afterRunOutcome(fresh, { status: 'error' });
  assert.deepEqual(once, { consecutiveFailures: 1, pausedReason: null, pausedNow: false });

  const twice = afterRunOutcome({ consecutiveFailures: 1, pausedReason: null }, { status: 'interrupted', stopReason: 'budget' });
  assert.deepEqual(twice, { consecutiveFailures: 2, pausedReason: 'failures', pausedNow: true });

  // A done run clears the count before it ever reaches two.
  assert.deepEqual(
    afterRunOutcome({ consecutiveFailures: 1, pausedReason: null }, { status: 'done' }),
    { consecutiveFailures: 0, pausedReason: null, pausedNow: false },
  );
  // A restart is not a failure, so it does not count towards the pause.
  assert.deepEqual(
    afterRunOutcome({ consecutiveFailures: 1, pausedReason: null }, { status: 'interrupted' }),
    { consecutiveFailures: 0, pausedReason: null, pausedNow: false },
  );
});

test('afterRunOutcome: does not un-pause, and does not re-report a pause it did not cause', () => {
  // A schedule the human stopped, or one the monthly cap stopped, stays
  // stopped until they resume it — a stray success is not consent.
  for (const reason of ['human', 'monthly-cap', 'failures'] as const) {
    assert.deepEqual(
      afterRunOutcome({ consecutiveFailures: 0, pausedReason: reason }, { status: 'done' }),
      { consecutiveFailures: 0, pausedReason: reason, pausedNow: false },
    );
    assert.deepEqual(
      afterRunOutcome({ consecutiveFailures: 3, pausedReason: reason }, { status: 'error' }),
      { consecutiveFailures: 4, pausedReason: reason, pausedNow: false },
    );
  }
});

test('decideTicks: nothing to do for schedules that are not due, disabled or paused', () => {
  assert.deepEqual(decide([schedule({ nextRunAt: at(2026, 4, 11, 3).getTime() })]), []);
  assert.deepEqual(decide([schedule({ nextRunAt: null })]), []);
  assert.deepEqual(decide([schedule({ enabled: false })]), []);
  for (const reason of ['failures', 'monthly-cap', 'human'] as const) {
    assert.deepEqual(decide([schedule({ pausedReason: reason })]), []);
  }
});

test('decideTicks: a due schedule starts, and its next firing is after now', () => {
  const actions = decide([schedule()]);
  assert.equal(actions.length, 1);
  const a = actions[0];
  assert.equal(a.kind, 'start');
  assert.equal(a.scheduleId, 's1');
  assert.equal(a.kind === 'start' && a.at, NOW.getTime());
  // Daily 03:00 from 09:00 today is 03:00 tomorrow.
  assert.equal(a.nextRunAt, at(2026, 4, 11, 3).getTime());
});

test('decideTicks: a busy project misses the mission rather than queueing it', () => {
  const busy = decide([schedule()], { busyProjectIds: new Set(['p1']) });
  assert.deepEqual(busy, [{ kind: 'skip', scheduleId: 's1', reason: 'project busy', nextRunAt: at(2026, 4, 11, 3).getTime() }]);
  // The array form of busyProjectIds says the same thing.
  assert.deepEqual(decide([schedule()], { busyProjectIds: ['p1'] }), busy);
  // Another project being busy is not this one's problem.
  assert.equal(decide([schedule()], { busyProjectIds: ['p2'] })[0].kind, 'start');
});

test('decideTicks: catch-up happens once, however long Foreman was down', () => {
  // A schedule whose slot was three months ago fires once now and then goes
  // back to its cadence — the next firing is computed from now, not from the
  // 90 missed 03:00s.
  const stale = schedule({ nextRunAt: at(2026, 1, 4, 3).getTime() });
  const [start] = decide([stale]);
  assert.equal(start.kind, 'start');
  assert.equal(start.nextRunAt, at(2026, 4, 11, 3).getTime());

  // Same for a skip: the missed slot does not linger in the past waiting to
  // fire again on the next pass.
  const [skip] = decide([stale], { busyProjectIds: ['p1'] });
  assert.equal(skip.kind, 'skip');
  assert.ok(skip.nextRunAt !== null && skip.nextRunAt > NOW.getTime());
});

test('decideTicks: the monthly ceiling pauses, and equal to the cap is still allowed', () => {
  const s = schedule({ budgetUsd: 5 });
  // 20 spent + 5 budget = 25 = the cap: allowed, the rule is strictly past it.
  assert.equal(decide([s], { monthSpend: { p1: 20 } })[0].kind, 'start');
  // A cent more and the run would cross it.
  assert.deepEqual(decide([s], { monthSpend: { p1: 20.01 } }), [
    { kind: 'pause', scheduleId: 's1', reason: 'monthly-cap', spent: 20.01, cap: 25 },
  ]);
  // The Map form says the same thing, and a pause does not advance the next
  // firing: a human resumes it and gets a fresh next time.
  const paused = decide([s], { monthSpend: new Map([['p1', 30]]) });
  assert.deepEqual(paused, [{ kind: 'pause', scheduleId: 's1', reason: 'monthly-cap', spent: 30, cap: 25 }]);
  assert.ok(!('nextRunAt' in paused[0]));
  // The ceiling is per project, and capFor decides it.
  assert.equal(decide([s], { monthSpend: { p1: 30 }, capFor: () => 100 })[0].kind, 'start');
});

test('decideTicks: one start per project, earliest due first, and the start charges the month', () => {
  const early = schedule({ id: 's-early', nextRunAt: at(2026, 4, 10, 3).getTime(), createdAt: 200 });
  const late = schedule({ id: 's-late', nextRunAt: at(2026, 4, 10, 7).getTime(), createdAt: 100 });
  // Given in the wrong order on purpose: due time decides, not array order.
  const actions = decide([late, early]);
  assert.deepEqual(actions.map((a) => [a.kind, a.scheduleId]), [['start', 's-early'], ['skip', 's-late']]);
  assert.equal(actions[1].kind === 'skip' && actions[1].reason, 'project busy');

  // Due at the same moment: the older schedule wins, so a later-created
  // neighbour cannot starve it night after night.
  const tie = decide([
    schedule({ id: 's-new', createdAt: 999 }),
    schedule({ id: 's-old', createdAt: 1 }),
  ]);
  assert.deepEqual(tie.map((a) => [a.kind, a.scheduleId]), [['start', 's-old'], ['skip', 's-new']]);

  // Different projects: both start, each on its own allowance.
  const two = decide([schedule({ id: 'a', projectId: 'p1' }), schedule({ id: 'b', projectId: 'p2' })]);
  assert.deepEqual(two.map((a) => a.kind), ['start', 'start']);

  // A start charges the project's month straight away, so no second schedule
  // can slip under the ceiling by being decided in the same pass. Here 24
  // spent leaves room for exactly one $1 run: the first takes it, and the
  // second is turned away — as busy, because one mission per project is the
  // stricter rule and it is checked first.
  const cheap = [
    schedule({ id: 'a', projectId: 'p1', budgetUsd: 1, createdAt: 1 }),
    schedule({ id: 'b', projectId: 'p1', budgetUsd: 1, createdAt: 2 }),
  ];
  const charged = decide(cheap, { monthSpend: { p1: 24 } });
  assert.deepEqual(charged.map((a) => [a.kind, a.scheduleId]), [['start', 'a'], ['skip', 'b']]);
  assert.equal(charged[1].kind === 'skip' && charged[1].reason, 'project busy');
  // Nothing started, so nothing is charged: both are judged against the same
  // spend, and the ceiling is what turns them away once the project is free.
  const none = decide(cheap, { monthSpend: { p1: 24.5 }, busyProjectIds: ['p1'] });
  assert.deepEqual(none.map((a) => a.kind), ['skip', 'skip']);
  assert.deepEqual(decide([cheap[0]], { monthSpend: { p1: 24.5 } }).map((a) => a.kind), ['pause']);
});
