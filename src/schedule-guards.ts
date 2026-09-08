/**
 * The rules a scheduled mission has to get past before it spends anything.
 *
 * A schedule fires while nobody is watching, which is the whole point and also
 * the whole danger: a mission that fails at 03:00 will fail again at 03:00
 * tomorrow, and a cadence that costs $3 a firing costs $90 a month if nothing
 * counts. So the ticker asks four questions every pass — is it due, is the
 * project free, has it been failing, and can the project still afford it — and
 * every one of those answers lives here rather than in the server.
 *
 * The point of the separation is testability: src/server.ts starts listening
 * on import, so nothing that imports it can be a unit test. These functions
 * take the world as arguments and return decisions; the server is left with
 * the doing.
 */
import type { Schedule } from './types.js';
import { nextRunAt } from './schedule.js';

/** Default ceiling on what a project's SCHEDULED runs may cost in one calendar month. */
export const DEFAULT_SCHEDULED_MONTHLY_CAP_USD = 25;

/**
 * What this project's scheduled runs have cost so far this calendar month.
 * Months are local, matching the local-time cadences: an operator who says
 * "every night at 2am" means their nights, and their month rolls over on their
 * midnight. Only runs with a scheduleId count; a hand-started mission spends
 * the human's attention, not the schedule's allowance.
 */
export function monthlyScheduledSpend(
  runs: Array<{ projectId?: string; scheduleId?: string; createdAt: number; costUsd: number }>,
  projectId: string,
  now: Date,
): number {
  const year = now.getFullYear();
  const month = now.getMonth();
  let total = 0;
  for (const run of runs) {
    if (!run.scheduleId || run.projectId !== projectId) continue;
    const at = new Date(run.createdAt);
    if (at.getFullYear() !== year || at.getMonth() !== month) continue;
    total += run.costUsd;
  }
  return total;
}

/**
 * Did this scheduled run fail for the purposes of the failure pause? — status
 * 'error', or 'interrupted' with a stopReason (budget/turns/time/tokens). An
 * interruption with no stopReason is a server restart sweeping its orphans,
 * not the schedule's fault, and pausing a schedule for that would mean a
 * reboot silently switches off the operator's nightly missions.
 */
export function isFailedOutcome(run: { status: string; stopReason?: string | null }): boolean {
  if (run.status === 'error') return true;
  return run.status === 'interrupted' && !!run.stopReason;
}

/**
 * The schedule's failure bookkeeping after one of its runs ended. Two
 * consecutive failures pause it: once is a bad night, twice is a standing
 * instruction that no longer works, and there is nobody awake to notice the
 * third. A 'done' resets the count but does not un-pause — a schedule stopped
 * for the monthly cap or by a human stays stopped until they say otherwise.
 */
export function afterRunOutcome(
  schedule: Pick<Schedule, 'consecutiveFailures' | 'pausedReason'>,
  run: { status: string; stopReason?: string | null },
): { consecutiveFailures: number; pausedReason: Schedule['pausedReason']; pausedNow: boolean } {
  if (!isFailedOutcome(run)) {
    return { consecutiveFailures: 0, pausedReason: schedule.pausedReason, pausedNow: false };
  }
  const consecutiveFailures = schedule.consecutiveFailures + 1;
  const pausedNow = schedule.pausedReason === null && consecutiveFailures >= 2;
  return {
    consecutiveFailures,
    pausedReason: pausedNow ? 'failures' : schedule.pausedReason,
    pausedNow,
  };
}

export type TickAction =
  | { kind: 'start'; scheduleId: string; at: number; nextRunAt: number | null }
  | { kind: 'skip'; scheduleId: string; reason: string; nextRunAt: number | null }
  | { kind: 'pause'; scheduleId: string; reason: 'monthly-cap'; spent: number; cap: number };

/**
 * What the ticker should do this pass. Pure: give it the world, it returns the
 * decisions; the server performs them.
 */
export function decideTicks(input: {
  schedules: Schedule[];
  now: Date;
  /** Projects that already have an active mission (reserveProject would fail). */
  busyProjectIds: Set<string> | string[];
  /** This month's scheduled spend per project id. */
  monthSpend: Map<string, number> | Record<string, number>;
  /** The project's monthly ceiling for scheduled runs. */
  capFor: (projectId: string) => number;
}): TickAction[] {
  const nowMs = input.now.getTime();
  // Copies, because a start in this pass has to be visible to the schedules
  // decided after it.
  const busy = new Set(input.busyProjectIds);
  const spend = input.monthSpend instanceof Map
    ? new Map(input.monthSpend)
    : new Map(Object.entries(input.monthSpend));

  // Earliest due first, tie-broken on createdAt, so that when two schedules in
  // one project come due together the older one starts and the newer one is
  // the one that waits. Without an order the array's order would decide, and a
  // schedule could be starved every night by a later-created neighbour.
  const due = input.schedules
    .filter((s) => s.enabled && s.pausedReason === null && s.nextRunAt !== null && s.nextRunAt <= nowMs)
    .sort((a, b) => (a.nextRunAt! - b.nextRunAt!) || (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));

  // The next firing is computed from `now`, never from the slot that was
  // missed. That is why this function takes `now` at all: if the machine was
  // asleep for a week, the schedule fires once on waking and then goes back to
  // its cadence — a missed mission is missed, not queued, and catch-up happens
  // at most once per schedule however long Foreman was down.
  const advance = (s: Schedule): number | null => {
    const next = nextRunAt(s.cadence, input.now);
    return next ? next.getTime() : null;
  };

  const actions: TickAction[] = [];
  for (const s of due) {
    if (busy.has(s.projectId)) {
      actions.push({ kind: 'skip', scheduleId: s.id, reason: 'project busy', nextRunAt: advance(s) });
      continue;
    }
    const spent = spend.get(s.projectId) ?? 0;
    const cap = input.capFor(s.projectId);
    if (spent + s.budgetUsd > cap) {
      // No advance: a paused schedule is resumed by a human, who then gets a
      // fresh next time. Leaving nextRunAt in the past would make it fire the
      // instant it came back.
      actions.push({ kind: 'pause', scheduleId: s.id, reason: 'monthly-cap', spent, cap });
      continue;
    }
    actions.push({ kind: 'start', scheduleId: s.id, at: nowMs, nextRunAt: advance(s) });
    // One active mission per project: this project is now taken for the rest
    // of the pass, and its month spend is charged straight away so a second
    // schedule cannot slip under the ceiling by being decided in the same tick.
    busy.add(s.projectId);
    spend.set(s.projectId, spent + s.budgetUsd);
  }
  return actions;
}
