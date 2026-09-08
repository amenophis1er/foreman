import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLEET_CHAT_ID, PHONE_CONTEXT_MS, fleetSummary, phoneRoute, scheduleSummary, scheduleTools, situation, type FleetHost, type FleetScheduleView } from './fleet-planner.js';
import type { Schedule } from './types.js';

test('plain phone text goes to the fleet planner when no project conversation is open', () => {
  assert.equal(phoneRoute(null), 'fleet');
});

test('plain phone text continues a project planner spoken to within the context window', () => {
  const now = 1_000_000_000;
  assert.equal(phoneRoute({ projectId: 'p1', at: now - 60_000 }, now), 'project');
  assert.equal(phoneRoute({ projectId: 'p1', at: now - PHONE_CONTEXT_MS }, now), 'project');
});

test('after the context window the front desk answers again', () => {
  const now = 1_000_000_000;
  assert.equal(phoneRoute({ projectId: 'p1', at: now - PHONE_CONTEXT_MS - 1 }, now), 'fleet');
});

test('the fleet chat id is one the store accepts and project listings skip', () => {
  assert.match(FLEET_CHAT_ID, /^[A-Za-z0-9_-]{1,64}$/);
  assert.ok(FLEET_CHAT_ID.startsWith('_'));
});

test('fleetSummary says what is running, what is waiting, and what finished last', () => {
  const now = 10 * 60_000 * 100;
  const text = fleetSummary([
    {
      id: 'a', name: 'P5', folder: '/x/P5', proposalWaiting: false, plannerReplying: false,
      running: { title: 'Build Tick', spend: '$0.54 of $5', startedAt: now - 47 * 60_000, waiting: ['approval: browser_navigate file:///x/P5/index.html'] },
    },
    {
      id: 'b', name: 'P7', folder: '/x/P7', proposalWaiting: true, plannerReplying: false,
      lastRun: { title: 'Pomodoro', status: 'done', endedAt: now - 3 * 3_600_000 },
    },
    { id: 'c', name: 'fresh', folder: '/x/fresh', proposalWaiting: false, plannerReplying: true },
  ], now);
  assert.match(text, /P5 \(\/x\/P5\)\n  RUNNING "Build Tick" · \$0\.54 of \$5 · started 47 min ago\n  waiting on the human: approval: browser_navigate/);
  assert.match(text, /P7 .*\n  idle · last run "Pomodoro" done 3 h ago\n  a mission proposal is waiting/);
  assert.match(text, /fresh .*\n  idle · no runs yet\n  its planner is replying right now/);
  assert.equal(fleetSummary([]), 'No projects are linked yet.');
});

const schedule = (o: Partial<Schedule> = {}): Schedule => ({
  id: 's1', projectId: 'a', name: 'nightly deps', brief: 'Update the dependencies',
  cadence: { kind: 'daily', at: '07:30' }, budgetUsd: 3, enabled: true, createdAt: 0,
  nextRunAt: null, consecutiveFailures: 0, pausedReason: null, ...o,
});

test('scheduleSummary says the cadence in words, the next run both ways, and why one is paused', () => {
  const now = 1_700_000_000_000;
  const views: FleetScheduleView[] = [
    { projectName: 'P5', monthSpendUsd: 4.2, monthlyCapUsd: 25, schedule: schedule({ nextRunAt: now + 15 * 3_600_000, lastOutcome: 'done', lastRunId: 'r9', lastRunAt: now - 9 * 3_600_000 }) },
    { projectName: 'P7', schedule: schedule({ id: 's2', name: 'audit', cadence: { kind: 'interval', everyMinutes: 360 }, budgetUsd: 2, enabled: false, pausedReason: 'failures', consecutiveFailures: 2 }) },
    { projectName: 'P7', schedule: schedule({ id: 's3', name: 'weekly report', cadence: { kind: 'weekly', day: 1, at: '09:00' }, enabled: false, pausedReason: 'monthly-cap' }) },
  ];
  const text = scheduleSummary(views, now);
  assert.match(text, /- P5: "nightly deps" · daily 07:30 · next .* \(in 15 h\)\n  enabled · \$3\.00 per run · last done \(r9\) 9 h ago\n  scheduled spend this month: \$4\.20 of \$25\.00/);
  assert.match(text, /- P7: "audit" · every 6 hours · no next run while paused\n  paused after 2 failed scheduled runs in a row · \$2\.00 per run · never run yet/);
  assert.match(text, /- P7: "weekly report" · every Monday 09:00 .*\n  paused at the project's monthly cap for scheduled spend/);
  assert.match(text, /read-only from here: created, edited, paused and resumed on the dashboard/);
  assert.match(scheduleSummary([]), /No schedules\. They are created on the dashboard/);
});

test('the front desk reads schedules and has no tool that changes one', async () => {
  const asked: Array<string | undefined> = [];
  const host = {
    listSchedules: async (ref?: string) => { asked.push(ref); return [{ projectName: 'P5', schedule: schedule({ nextRunAt: Date.now() + 3_600_000 }) }]; },
  } as unknown as FleetHost;
  const tools = scheduleTools(host);
  assert.deepEqual(tools.map((t) => t.name), ['list_schedules']);
  assert.match(tools[0].description, /Read-only.*dashboard/s);
  const out = await tools[0].handler({ project: 'P5' } as never, undefined);
  assert.deepEqual(asked, ['P5']);
  assert.match(String((out.content as Array<{ text: string }>)[0].text), /"nightly deps" · daily 07:30/);
  // A host from before schedules existed says so instead of guessing.
  const bare = await scheduleTools({} as FleetHost)[0].handler({} as never, undefined);
  assert.match(String((bare.content as Array<{ text: string }>)[0].text), /cannot list schedules/);
});

test('situation carries the clock, the channel, and the news since the last message', () => {
  const now = new Date(2026, 8, 6, 14, 5);
  const s = situation({ via: 'telegram', sinceMs: 12 * 60_000, news: ['13:58 P7 — mission ended: done ($0.78)'] }, now);
  assert.match(s, /NOW: .*2026.*14:05|NOW: .*2:05/);
  assert.match(s, /ARRIVED VIA TELEGRAM/);
  assert.match(s, /SINCE THE HUMAN'S LAST MESSAGE \(12 min ago\)/);
  assert.match(s, /- 13:58 P7 — mission ended: done/);
  const quiet = situation({ via: 'http', sinceMs: 2 * 3_600_000, news: [] }, now);
  assert.match(quiet, /ARRIVED VIA THE DESK/);
  assert.match(quiet, /Nothing notable happened .*\(2\.0 h ago\)/);
});
