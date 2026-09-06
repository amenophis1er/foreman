import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLEET_CHAT_ID, PHONE_CONTEXT_MS, fleetSummary, phoneRoute } from './fleet-planner.js';

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
