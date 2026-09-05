import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import {
  DEFAULT_REPEAT_LIMIT, DIRECTOR_CHARTER, MissionRun, RECENT_LINES, WORKER_CHARTER, WORK_DIR, accumulateUsage,
  activityHint, ensureIgnoreLines, loopingWorkerReport,
  stalledWorkerReport, workerStatusBlock,
  watchRepeats, watchSilence, REPEAT_EXEMPT, observeToolUse,
  DEFAULT_ASK_TIMEOUT_MS, armAskTimeout, unattendedAnswer, unattendedDenyMessage,
} from './orchestrator.js';
import { makePolicy, type PendingPermission } from './policy.js';
import type { AgentEnv } from './provider.js';
import type { RunMeta } from './types.js';

function meta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'run-1', folder: '/tmp/x', mission: 'test', budgetUsd: 5,
    status: 'running', costUsd: 0, createdAt: Date.now(), workers: [],
    ...over,
  };
}

const noopAgentEnv = { director: {} as AgentEnv, worker: {} as AgentEnv };

// accumulateUsage is exported precisely so this needs no SDK, no query()
// mock, and no network — the shape it defends is the raw `usage` object off
// an SDK `result` message, which the tests below construct by hand.

test('accumulateUsage sums two result messages', () => {
  const first = accumulateUsage(
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
  );
  const second = accumulateUsage(first, {
    input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 0, cache_creation_input_tokens: 20,
  });
  assert.deepEqual(second, {
    inputTokens: 300, outputTokens: 125, cacheReadTokens: 10, cacheWriteTokens: 25,
  });
});

test('accumulateUsage tolerates a missing usage object', () => {
  const start = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 };
  assert.deepEqual(accumulateUsage(start, undefined), start);
  assert.deepEqual(accumulateUsage(start, null), start);
});

test('accumulateUsage tolerates a partial usage object without producing NaN', () => {
  const start = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 10 };
  // Only input_tokens present — the other three fields are absent, as a
  // provider that does not report cache usage at all would send it.
  const next = accumulateUsage(start, { input_tokens: 40 });
  assert.deepEqual(next, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 10 });
  for (const v of Object.values(next)) assert.ok(Number.isFinite(v), `${v} is not finite`);
});

test('accumulateUsage ignores non-numeric or NaN fields rather than throwing or poisoning the sum', () => {
  const start = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const next = accumulateUsage(start, {
    input_tokens: 'lots', output_tokens: NaN, cache_read_input_tokens: undefined, cache_creation_input_tokens: 5,
  });
  assert.deepEqual(next, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 5 });
});

// MissionRun's own addUsage/turns bookkeeping is private, reached here via
// bracket access — the SDK connection it would otherwise require (query(),
// a live director) is out of scope for what this covers: the accumulation
// into meta, not the mission loop around it.

test('MissionRun accumulates usage across two result messages into meta.usage', () => {
  const saved: RunMeta[] = [];
  const run = new MissionRun(meta(), () => {}, (m) => saved.push({ ...m }), noopAgentEnv);

  assert.deepEqual(run.meta.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

  (run as unknown as { addUsage(raw: unknown): void }).addUsage({
    input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1,
  });
  (run as unknown as { addUsage(raw: unknown): void }).addUsage({
    input_tokens: 20, output_tokens: 8,
  });

  assert.deepEqual(run.meta.usage, { inputTokens: 30, outputTokens: 13, cacheReadTokens: 2, cacheWriteTokens: 1 });
  assert.ok(saved.length >= 2, 'saveMeta should be called on every accumulation');
});

test('MissionRun does not throw on a result message with no usage object at all', () => {
  const run = new MissionRun(meta(), () => {}, () => {}, noopAgentEnv);
  assert.doesNotThrow(() => (run as unknown as { addUsage(raw: unknown): void }).addUsage(undefined));
  assert.deepEqual(run.meta.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('MissionRun persists director turns into meta.turns as it counts them', () => {
  const run = new MissionRun(meta(), () => {}, () => {}, noopAgentEnv) as unknown as {
    turns: number;
    addUsage(raw: unknown): void;
  };
  run.turns++;
  run.turns++;
  run.addUsage({ input_tokens: 1 });
  assert.equal((run as unknown as { meta: RunMeta }).meta.turns, 2);
});

test('MissionRun resumes usage and turns from persisted meta rather than resetting to zero', () => {
  const prior = meta({
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 5 },
    turns: 7,
  });
  const run = new MissionRun(prior, () => {}, () => {}, noopAgentEnv);
  assert.deepEqual(run.meta.usage, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 5 });
  assert.equal((run as unknown as { turns: number }).turns, 7);

  (run as unknown as { addUsage(raw: unknown): void }).addUsage({ input_tokens: 1, output_tokens: 1 });
  assert.deepEqual(run.meta.usage, { inputTokens: 101, outputTokens: 41, cacheReadTokens: 5, cacheWriteTokens: 5 });
});

test('cost event carries usage and metered alongside the dollar figure', () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const run = new MissionRun(meta({ metered: false }), (event, data) => events.push({ event, data }), () => {}, noopAgentEnv);

  (run as unknown as { addCost(usd: number | undefined): void }).addCost(0.01);

  const cost = events.find((e) => e.event === 'cost');
  assert.ok(cost, 'a cost event should have been emitted');
  const data = cost!.data as { costUsd: number; budgetUsd: number; usage: unknown; metered: boolean };
  assert.equal(data.costUsd, 0.01);
  assert.equal(data.metered, false);
  assert.deepEqual(data.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

// ---------------------------------------------------------------------------
// A director's exit is not proof its mission succeeded
// ---------------------------------------------------------------------------

/** Writes a mission doc into a temp folder and reads back the unmet criteria. */
async function unmetFor(doc: string | null): Promise<string[] | null> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'foreman-donewhen-'));
  if (doc !== null) {
    await mkdir(path.join(folder, '.foreman'), { recursive: true });
    await writeFile(path.join(folder, '.foreman', 'MISSION.md'), doc);
  }
  const run = new MissionRun({ ...meta(), folder }, () => {}, () => {}, noopAgentEnv);
  try {
    return await (run as unknown as { unmetCriteria(): Promise<string[] | null> }).unmetCriteria();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('unticked DONE WHEN criteria are reported', async () => {
  assert.deepEqual(await unmetFor([
    '# MISSION', '', '## DONE WHEN',
    '- [x] The site is built',
    '- [ ] Screenshots are saved',
    '- [ ] The console is clean',
    '', '## Plan',
    '- [ ] a plan step that is NOT a completion criterion',
  ].join('\n')), ['Screenshots are saved', 'The console is clean']);
});

test('a fully ticked doc reports nothing unmet', async () => {
  assert.deepEqual(await unmetFor([
    '## DONE WHEN', '- [x] one', '- [X] two (capital X counts)',
  ].join('\n')), []);
});

test('nothing to judge by returns null, not failure', async () => {
  // No doc at all, and a doc with no DONE WHEN section. Absence of evidence is
  // not evidence of failure — a director that never wrote a doc has already
  // failed more visibly than this check could report.
  assert.equal(await unmetFor(null), null);
  assert.equal(await unmetFor('# MISSION\n\nno criteria here'), null);
  assert.equal(await unmetFor('## DONE WHEN\n\nprose, no checkboxes'), null);
});

test('the plan section cannot mask an unfinished criterion', async () => {
  // The section ends at the next heading; Plan boxes describe the route, and a
  // route can legitimately change.
  assert.deepEqual(await unmetFor([
    '## DONE WHEN', '- [ ] the one that matters',
    '## Plan', '- [x] every plan step ticked',
  ].join('\n')), ['the one that matters']);
});

// ---------------------------------------------------------------------------
// Pricing a run from the endpoint's own rates
// ---------------------------------------------------------------------------

const RATES = { input: 0.000002, output: 0.00001 };

test('a role with published rates is billed from its own tokens', () => {
  const run = new MissionRun(meta({ costBasis: 'priced' }), () => {}, () => {}, noopAgentEnv,
    { director: RATES }) as unknown as { addUsage(raw: unknown, role?: string): void; meta: RunMeta };

  run.addUsage({ input_tokens: 1000, output_tokens: 500 });
  assert.ok(Math.abs(run.meta.costUsd - 0.007) < 1e-9, `got ${run.meta.costUsd}`);
});

test('each turn is billed for its own tokens, never for the running total', () => {
  // Charging the per-token rate against the accumulated figure would bill
  // every turn for every turn before it — a cost curve that looks like real
  // spend and is quadratic in the number of turns.
  const run = new MissionRun(meta({ costBasis: 'priced' }), () => {}, () => {}, noopAgentEnv,
    { director: RATES }) as unknown as { addUsage(raw: unknown, role?: string): void; meta: RunMeta };

  for (let i = 0; i < 3; i++) run.addUsage({ input_tokens: 1000 });
  assert.ok(Math.abs(run.meta.costUsd - 0.006) < 1e-9, `got ${run.meta.costUsd}`);
  assert.equal(run.meta.usage!.inputTokens, 3000);
});

test('the SDK figure is ignored for a role Foreman prices itself', () => {
  // The double-count trap. The SDK prices every response with Anthropic's
  // table, so on a gateway role its number is fiction; adding it to a total
  // computed from the endpoint's own rates would corrupt the honest figure.
  const run = new MissionRun(meta({ costBasis: 'priced' }), () => {}, () => {}, noopAgentEnv,
    { director: RATES }) as unknown as {
      addUsage(raw: unknown, role?: string): void;
      addCost(usd: number | undefined, role?: string): void;
      meta: RunMeta;
    };

  run.addUsage({ input_tokens: 1000 });
  run.addCost(4.20);
  assert.ok(Math.abs(run.meta.costUsd - 0.002) < 1e-9, `SDK fiction leaked in: ${run.meta.costUsd}`);
});

test('a role with no published rates still uses the SDK figure', () => {
  // An Anthropic-native role: the SDK's number is the real one, and Foreman
  // must not stop trusting it just because the other half of the run is on a
  // gateway.
  const run = new MissionRun(meta({ costBasis: 'priced' }), () => {}, () => {}, noopAgentEnv,
    { worker: RATES }) as unknown as {
      addCost(usd: number | undefined, role?: string): void; meta: RunMeta;
    };

  run.addCost(0.5, 'director');
  assert.equal(run.meta.costUsd, 0.5);
});

test('a mixed run bills each role with its own rates', () => {
  const run = new MissionRun(meta({ costBasis: 'priced' }), () => {}, () => {}, noopAgentEnv, {
    director: { input: 0.00001, output: 0.00001 },
    worker: { input: 0.000001, output: 0.000001 },
  }) as unknown as { addUsage(raw: unknown, role?: string): void; meta: RunMeta };

  run.addUsage({ input_tokens: 1000 }, 'director');   // 0.01
  run.addUsage({ input_tokens: 1000 }, 'worker');     // 0.001
  assert.ok(Math.abs(run.meta.costUsd - 0.011) < 1e-9, `got ${run.meta.costUsd}`);
});

test('a priced gateway run still arms the budget cap', () => {
  // The point of pricing it: a real figure is a figure the cap may act on.
  const events: Array<{ event: string; data: any }> = [];
  const run = new MissionRun(
    meta({ costBasis: 'priced', budgetUsd: 0.01 }), (event, data) => events.push({ event, data }),
    () => {}, noopAgentEnv, { director: RATES },
  ) as unknown as { addUsage(raw: unknown, role?: string): void };

  run.addUsage({ output_tokens: 2000 }); // 0.02 — past 125% of a $0.01 cap
  assert.ok(events.some((e) => e.event === 'budget_alert' && e.data.level === 'exceeded'),
    'a real overrun on real rates must still stop the run');
});

// ---------------------------------------------------------------------------
// A worker that goes quiet must not hold the mission open
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('silence past the threshold fires exactly once', async () => {
  let fired = 0;
  let quietFor = 0;
  const w = watchSilence(60, (q) => { fired++; quietFor = q; });
  await sleep(250);
  w.stop();
  assert.equal(fired, 1, 'a stall is reported once, not once per poll');
  assert.ok(quietFor >= 60, `should report how long it was quiet, got ${quietFor}`);
});

test('any sign of life resets the clock', async () => {
  // The property that decides whether a slow-but-working worker survives: a
  // worker emits a message for every tool call, so activity must postpone the
  // verdict indefinitely.
  let fired = 0;
  const w = watchSilence(120, () => fired++);
  for (let i = 0; i < 6; i++) { await sleep(40); w.touch(); }
  assert.equal(fired, 0, 'a working worker must never be killed');
  w.stop();
});

test('a stopped watchdog never fires afterwards', async () => {
  // It is stopped in a finally block, so this is the difference between a
  // clean finish and a spurious "stalled" on a worker that already returned.
  let fired = 0;
  const w = watchSilence(50, () => fired++);
  w.stop();
  await sleep(200);
  assert.equal(fired, 0);
});

test('touching after a stall cannot revive the verdict', async () => {
  // The worker has already been interrupted by then; letting a late message
  // clear the flag would leave the run reporting success for a worker that
  // was killed.
  let fired = 0;
  const w = watchSilence(50, () => fired++);
  await sleep(200);
  w.touch();
  await sleep(150);
  assert.equal(fired, 1);
  w.stop();
});

test('the stall report steers the director away from repeating it', () => {
  const r = stalledWorkerReport('worker-2', 8 * 60_000);
  assert.match(r, /STALLED/);
  assert.match(r, /8 minute/);
  // The one response guaranteed to waste the same minutes again.
  assert.match(r, /Do NOT immediately respawn/);
  // And the escape hatch, so a run cannot spend itself entirely on silence.
  assert.match(r, /ask_human/);
  // It must not read as a task failure: that framing invites a retry.
  assert.match(r, /did not fail a task/);
});

test('partial output before the silence is handed back, not discarded', () => {
  const r = stalledWorkerReport('worker-1', 60_000, 'wrote index.html');
  assert.match(r, /Partial output/);
  assert.match(r, /wrote index\.html/);
  assert.doesNotMatch(stalledWorkerReport('worker-1', 60_000), /Partial output/);
});

// watchRepeats is the loop rule on its own, fed by hand: the tool_use blocks
// it sees in production come off SDK assistant messages, and none of what
// follows depends on the SDK to construct them.

test('watchRepeats fires once at exactly the limit of consecutive identical calls', () => {
  const hits: Array<{ toolName: string; count: number }> = [];
  const r = watchRepeats(3, (i) => hits.push({ toolName: i.toolName, count: i.count }));
  r.observe('Bash', { command: 'npm test' });
  r.observe('Bash', { command: 'npm test' });
  assert.equal(hits.length, 0); // two identical calls is a retry, not a loop
  r.observe('Bash', { command: 'npm test' });
  assert.deepEqual(hits, [{ toolName: 'Bash', count: 3 }]);
});

test('a different call between repeats breaks the streak', () => {
  let fired = 0;
  const r = watchRepeats(3, () => fired++);
  r.observe('Bash', { command: 'npm test' });
  r.observe('Bash', { command: 'npm test' });
  r.observe('Read', { file_path: 'a.ts' }); // reading the failure output is progress
  r.observe('Bash', { command: 'npm test' });
  r.observe('Bash', { command: 'npm test' });
  assert.equal(fired, 0);
  // Same tool with different input is a different call too.
  r.observe('Bash', { command: 'npm test -- --grep x' });
  r.observe('Bash', { command: 'npm test' });
  assert.equal(fired, 0);
});

test('key order in the input does not defeat detection', () => {
  let fired = 0;
  const r = watchRepeats(3, () => fired++);
  r.observe('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' });
  r.observe('Edit', { new_string: 'y', file_path: 'a.ts', old_string: 'x' });
  r.observe('Edit', { old_string: 'x', new_string: 'y', file_path: 'a.ts' });
  assert.equal(fired, 1);
  // Including nested objects.
  const r2 = watchRepeats(2, () => fired++);
  r2.observe('T', { a: { b: 1, c: [1, { d: 2, e: 3 }] } });
  r2.observe('T', { a: { c: [1, { e: 3, d: 2 }], b: 1 } });
  assert.equal(fired, 2);
});

test('a streak that continues past the report does not re-fire', () => {
  // The caller has already acted on the first report; a second one for the
  // same loop would be a second interrupt, or a second notice, for nothing.
  let fired = 0;
  const r = watchRepeats(2, () => fired++);
  for (let i = 0; i < 10; i++) r.observe('Bash', { command: 'ls' });
  assert.equal(fired, 1);
});

test('reset() re-arms detection for the same call', () => {
  // The director path notifies then resets, so that a director which ignores
  // the notice and starts the same streak again is caught a second time.
  let fired = 0;
  const r = watchRepeats(2, () => fired++);
  r.observe('Bash', { command: 'ls' });
  r.observe('Bash', { command: 'ls' });
  assert.equal(fired, 1);
  r.observe('Bash', { command: 'ls' });
  assert.equal(fired, 1);
  r.reset();
  r.observe('Bash', { command: 'ls' });
  assert.equal(fired, 1); // one call after a reset is a first call, not a streak
  r.observe('Bash', { command: 'ls' });
  assert.equal(fired, 2);
});

test('the default repeat limit tolerates an ordinary retry-with-backoff', () => {
  let fired = 0;
  const r = watchRepeats(DEFAULT_REPEAT_LIMIT, () => fired++);
  for (let i = 0; i < 3; i++) r.observe('Bash', { command: 'curl localhost:3000' });
  assert.equal(fired, 0);
});

test('the looping report steers the director away from resending the brief', () => {
  const r = loopingWorkerReport('worker-3', 'Bash', 5);
  assert.match(r, /LOOPING/);
  assert.match(r, /worker-3/);
  // What it was repeating, so the director can see the trap.
  assert.match(r, /identical Bash call 5 times/);
  assert.match(r, /Do NOT respawn/);
  assert.match(r, /ask_human/);
  // It must not read as a task failure: that framing invites a retry.
  assert.match(r, /not a task that failed/);
  assert.doesNotMatch(r, /Output before/);
  assert.match(loopingWorkerReport('worker-3', 'Bash', 5, 'ran tests'), /Output before it was stopped:\nran tests/);
});

// ---------------------------------------------------------------------------
// Spawning is asynchronous; the director supervises instead of waiting
// ---------------------------------------------------------------------------

type Outcome = { report: string; isError: boolean };
type ToolSurface = {
  runWorker(id: string, prompt: string, resume?: string): Promise<Outcome>;
  capReached(): string | null;
  spawnWorkerTool(a: { task: string }): string;
  checkWorkersTool(a?: { workerId?: string }): string;
  waitForWorkerTool(a?: { workerId?: string; timeoutSeconds?: number }): Promise<string>;
  messageWorkerTool(a: { worker_id: string; message: string }): Promise<string>;
  workers: Map<string, {
    status: string; sessionId?: string; recent?: string[]; toolCalls?: number;
    progress?: { status: string; done?: string[]; next?: string; blocked?: string; at: number };
  }>;
};

/**
 * A run whose workers are simulated: launchWorker() does the bookkeeping
 * (record, events, done promise, stored report) around a runWorker() that
 * here just sleeps and answers, so the tool handlers can be driven without an
 * SDK session behind them.
 */
function stubbedRun(script: (id: string, prompt: string) => Promise<Outcome>) {
  const events: Array<{ event: string; data: any }> = [];
  const run = new MissionRun(meta(), (event, data) => events.push({ event, data }), () => {}, noopAgentEnv);
  const t = run as unknown as ToolSurface;
  t.runWorker = script;
  return { run, t, events };
}

const slowWorker = (ms: number, report = 'did the thing') =>
  async (id: string) => { await sleep(ms); return { report: `${id}: ${report}`, isError: false }; };

test('spawn_worker returns before the worker resolves', async () => {
  const { t, events } = stubbedRun(slowWorker(80));
  const before = Date.now();
  const reply = t.spawnWorkerTool({ task: 'build it' });
  assert.ok(Date.now() - before < 50, 'the director must not be held for the worker');
  assert.match(reply, /worker-1/);
  assert.match(reply, /running/);
  assert.match(reply, /check_workers/);
  assert.match(reply, /wait_for_worker/);
  // The record and its start event exist by the time the reply is built.
  assert.equal(t.workers.get('worker-1')?.status, 'running');
  assert.ok(events.some((e) => e.event === 'worker_started' && e.data.id === 'worker-1'));
  await t.waitForWorkerTool({ workerId: 'worker-1' });
});

test('two spawns run concurrently and both show as running', async () => {
  const { t } = stubbedRun(slowWorker(100));
  t.spawnWorkerTool({ task: 'a' });
  t.spawnWorkerTool({ task: 'b' });
  const view = t.checkWorkersTool();
  assert.match(view, /worker-1  running/);
  assert.match(view, /worker-2  running/);
  // Concurrent, not sequential: both finish in about one worker's time.
  const start = Date.now();
  await t.waitForWorkerTool({ workerId: 'worker-1' });
  await t.waitForWorkerTool({ workerId: 'worker-2' });
  assert.ok(Date.now() - start < 180, `took ${Date.now() - start}ms — workers ran one after the other`);
});

test('check_workers shows a finished report, and shows it again on the next call', async () => {
  const { t, events } = stubbedRun(slowWorker(10, 'wrote index.html'));
  t.spawnWorkerTool({ task: 'x' });
  await t.waitForWorkerTool({ workerId: 'worker-1' });
  const first = t.checkWorkersTool();
  assert.match(first, /worker-1  done/);
  assert.match(first, /report:\n\s+worker-1: wrote index\.html/);
  // Already shown is not deleted: the director may need to re-read it.
  assert.match(t.checkWorkersTool({ workerId: 'worker-1' }), /wrote index\.html/);
  // The footer appears once for the whole response, not per worker.
  assert.equal(first.match(/\[Run cost so far/g)?.length, 1);
  const finished = events.find((e) => e.event === 'worker_finished');
  assert.equal(finished?.data.status, 'done');
  assert.match(finished?.data.report, /wrote index\.html/);
});

test('wait_for_worker returns the report on finish', async () => {
  const { t } = stubbedRun(slowWorker(30, 'tests pass'));
  t.spawnWorkerTool({ task: 'x' });
  const out = await t.waitForWorkerTool({ workerId: 'worker-1' });
  assert.match(out, /^\[worker-1 finished\] worker-1: tests pass/);
  assert.match(out, /Run cost so far/);
  // Asking again for a worker that has already finished answers immediately.
  assert.match(await t.waitForWorkerTool({ workerId: 'worker-1' }), /tests pass/);
});

test('wait_for_worker on timeout reports still-running and does not throw', async () => {
  const { t } = stubbedRun(slowWorker(150));
  t.spawnWorkerTool({ task: 'x' });
  const out = await t.waitForWorkerTool({ workerId: 'worker-1', timeoutSeconds: 0.02 });
  assert.match(out, /worker-1  running/);
  assert.match(out, /Still running/);
  assert.match(out, /call wait_for_worker again/i);
  assert.equal(t.workers.get('worker-1')?.status, 'running');
  await t.waitForWorkerTool({ workerId: 'worker-1' });
});

test('wait_for_worker with no id returns when the first of two finishes', async () => {
  const { t } = stubbedRun(async (id) => {
    await sleep(id === 'worker-2' ? 20 : 200);
    return { report: `${id} done`, isError: false };
  });
  t.spawnWorkerTool({ task: 'slow' });
  t.spawnWorkerTool({ task: 'fast' });
  const start = Date.now();
  const out = await t.waitForWorkerTool();
  assert.ok(Date.now() - start < 150, 'must not wait for the slow one');
  assert.match(out, /^\[worker-2 finished\] worker-2 done/);
  assert.equal(t.workers.get('worker-1')?.status, 'running');
  await t.waitForWorkerTool({ workerId: 'worker-1' });
  assert.match(await t.waitForWorkerTool(), /No worker is running/);
});

test('a failed worker is reported as FAILED and kept as error', async () => {
  const { t } = stubbedRun(async () => ({ report: 'BLOCKED: which port?', isError: true }));
  t.spawnWorkerTool({ task: 'x' });
  const out = await t.waitForWorkerTool({ workerId: 'worker-1' });
  assert.match(out, /^\[worker-1 FAILED\] BLOCKED/);
  assert.equal(t.workers.get('worker-1')?.status, 'error');
});

test('the spawn gate still refuses once a cap is reached', () => {
  const { t } = stubbedRun(slowWorker(10));
  t.capReached = () => 'TURN CAP REACHED: 150 director turns.';
  const reply = t.spawnWorkerTool({ task: 'one more' });
  assert.match(reply, /Do not start new work/);
  assert.equal(t.workers.size, 0, 'no worker may be started past the cap');
});

test('message_worker refuses a worker that is still running rather than forking its session', async () => {
  const { t } = stubbedRun(async (id) => {
    t.workers.get(id)!.sessionId = 'sess-1';
    await sleep(60);
    return { report: 'ok', isError: false };
  });
  t.spawnWorkerTool({ task: 'x' });
  await sleep(5);
  assert.match(await t.messageWorkerTool({ worker_id: 'worker-1', message: 'also do y' }), /still running/);
  await t.waitForWorkerTool({ workerId: 'worker-1' });
  // Finished: the follow-up resumes it, alongside whatever else is running.
  t.spawnWorkerTool({ task: 'other' });
  const out = await t.messageWorkerTool({ worker_id: 'worker-1', message: 'also do y' });
  assert.match(out, /^\[worker-1 finished\] ok/);
  await t.waitForWorkerTool({ workerId: 'worker-2' });
});

test('a worker persisted as running is not resurrected as running on resume', () => {
  const run = new MissionRun(meta({ workers: [
    { id: 'worker-1', status: 'running', costUsd: 0, task: 'x', sessionId: 's' },
  ] }), () => {}, () => {}, noopAgentEnv) as unknown as ToolSurface;
  const view = run.checkWorkersTool({ workerId: 'worker-1' });
  assert.match(view, /worker-1  error/);
  assert.match(view, /restarted/);
});

test('activityHint names the argument that identifies the call', () => {
  assert.equal(activityHint('Bash', { command: 'npm test', description: 'run tests' }), 'Bash npm test');
  assert.equal(activityHint('Read', { file_path: 'src/a.ts' }), 'Read src/a.ts');
  assert.equal(activityHint('Custom', { whatever: 42 }), 'Custom');
  assert.equal(activityHint('Custom', { note: 'a\n  multi   line' }), 'Custom a multi line');
  assert.ok(activityHint('Bash', { command: 'x'.repeat(200) }).length < 70);
});

test('workerStatusBlock reads as one glance: age, last activity, calls, recent, report', () => {
  const now = 1_000_000;
  const running = workerStatusBlock({
    id: 'worker-1', status: 'running', costUsd: 0, task: 't',
    startedAt: now - 134_000, lastActivityAt: now - 3_000, toolCalls: 12, recent: ['Read a.ts', 'Bash npm test'],
  }, now);
  assert.match(running, /^worker-1  running  age 2m14s  last activity 3s ago  12 tool calls/);
  assert.match(running, /recent:\n    Read a\.ts\n    Bash npm test/);
  assert.doesNotMatch(running, /report/);
  const done = workerStatusBlock({
    id: 'worker-2', status: 'error', costUsd: 0, task: 't', isError: true, report: 'line1\nline2',
  }, now);
  assert.match(done, /report \(FAILED\):\n    line1\n    line2/);
});

test('the recent window is bounded and counts tool calls', () => {
  const run = new MissionRun(meta(), () => {}, () => {}, noopAgentEnv) as unknown as {
    noteActivity(w: any, m: any): void;
  };
  const w: any = { id: 'w', status: 'running', costUsd: 0, task: 't' };
  for (let i = 0; i < RECENT_LINES + 4; i++) {
    run.noteActivity(w, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `c${i}` } }] } });
  }
  run.noteActivity(w, { type: 'assistant', message: { content: [{ type: 'text', text: 'Now I will run the tests.' }] } });
  assert.equal(w.toolCalls, RECENT_LINES + 4);
  assert.equal(w.recent.length, RECENT_LINES);
  assert.equal(w.recent.at(-1), '"Now I will run the tests."');
  assert.ok(typeof w.lastActivityAt === 'number');
});

// ---------------------------------------------------------------------------
// report_progress: the worker's own account, beside the harness's
// ---------------------------------------------------------------------------

type ProgressSurface = ToolSurface & {
  reportProgressTool(id: string, a: { status: string; done?: string[]; next?: string; blocked?: string }): string;
};

test('a progress report is stored on the record with a timestamp and emitted', async () => {
  const { run, t, events } = stubbedRun(slowWorker(60));
  const p = t as ProgressSurface;
  t.spawnWorkerTool({ task: 'x' });
  const before = Date.now();
  const ack = p.reportProgressTool('worker-1', {
    status: 'two of three files written', done: ['a.ts', 'b.ts'], next: 'c.ts', blocked: undefined,
  });
  assert.match(ack, /Noted/);
  const w = p.workers.get('worker-1')!;
  assert.equal(w.progress?.status, 'two of three files written');
  assert.deepEqual(w.progress?.done, ['a.ts', 'b.ts']);
  assert.equal(w.progress?.next, 'c.ts');
  assert.equal(w.progress?.blocked, undefined);
  assert.ok(typeof w.progress?.at === 'number' && w.progress.at >= before);
  const ev = events.find((e) => e.event === 'worker_progress');
  assert.deepEqual(ev?.data, {
    id: 'worker-1', status: 'two of three files written', done: ['a.ts', 'b.ts'], next: 'c.ts', blocked: undefined,
  });
  // Persisted like every other field: the director may read it after a restart.
  assert.equal(run.meta.workers.find((x) => x.id === 'worker-1')?.progress?.status, 'two of three files written');
  await t.waitForWorkerTool({ workerId: 'worker-1' });
});

test('syncWorkersMeta hands progress to the meta sink', async () => {
  let saved: RunMeta | undefined;
  const run = new MissionRun(meta(), () => {}, (m) => { saved = structuredClone(m); }, noopAgentEnv);
  const t = run as unknown as ProgressSurface;
  t.runWorker = slowWorker(30);
  t.spawnWorkerTool({ task: 'x' });
  t.reportProgressTool('worker-1', { status: 'halfway', blocked: 'port 3000 is taken' });
  assert.equal(saved?.workers[0]?.progress?.status, 'halfway');
  assert.equal(saved?.workers[0]?.progress?.blocked, 'port 3000 is taken');
  await t.waitForWorkerTool({ workerId: 'worker-1' });
});

test('the progress line lands in recent, and check_workers prints progress above recent', async () => {
  const { t } = stubbedRun(slowWorker(60));
  const p = t as ProgressSurface;
  t.spawnWorkerTool({ task: 'x' });
  p.reportProgressTool('worker-1', { status: 'tests green', done: ['migration'], next: 'wire the route' });
  const w = p.workers.get('worker-1')!;
  assert.equal(w.recent?.at(-1), 'progress: tests green');
  const view = t.checkWorkersTool({ workerId: 'worker-1' });
  assert.match(view, /progress \(\d+s ago\): tests green\n    done: migration\n    next: wire the route/);
  assert.ok(view.indexOf('progress') < view.indexOf('recent:'), 'the worker\'s account comes before the harness\'s');
  // A blocker is loud in the timeline too, since that line may outlive the report.
  p.reportProgressTool('worker-1', { status: 'stuck', blocked: 'no DB credentials' });
  assert.equal(w.recent?.at(-1), 'progress: stuck — BLOCKED: no DB credentials');
  assert.match(t.checkWorkersTool({ workerId: 'worker-1' }), /blocked: no DB credentials/);
  await t.waitForWorkerTool({ workerId: 'worker-1' });
});

test('wait_for_worker on timeout shows the progress report too', async () => {
  const { t } = stubbedRun(slowWorker(150));
  const p = t as ProgressSurface;
  t.spawnWorkerTool({ task: 'x' });
  p.reportProgressTool('worker-1', { status: 'step 3 of 5' });
  const out = await t.waitForWorkerTool({ workerId: 'worker-1', timeoutSeconds: 0.02 });
  assert.match(out, /progress .*: step 3 of 5/);
  await t.waitForWorkerTool({ workerId: 'worker-1' });
});

test('progress status is capped at 200 chars and flattened to one line', async () => {
  const { t } = stubbedRun(slowWorker(30));
  const p = t as ProgressSurface;
  t.spawnWorkerTool({ task: 'x' });
  p.reportProgressTool('worker-1', { status: `a\n b ${'x'.repeat(400)}` });
  const status = p.workers.get('worker-1')!.progress!.status;
  assert.equal(status.length, 200);
  assert.doesNotMatch(status, /\n/);
  assert.match(status, /^a b x+…$/);
  await t.waitForWorkerTool({ workerId: 'worker-1' });
});

test('a progress report for an unknown worker does not throw', () => {
  const { t, events } = stubbedRun(slowWorker(10));
  const p = t as ProgressSurface;
  assert.doesNotThrow(() => p.reportProgressTool('worker-9', { status: 'hello' }));
  assert.match(p.reportProgressTool('worker-9', { status: 'hello' }), /No record/);
  assert.ok(!events.some((e) => e.event === 'worker_progress'));
});

test('the report_progress call itself is counted but not duplicated in recent', () => {
  const run = new MissionRun(meta(), () => {}, () => {}, noopAgentEnv) as unknown as {
    noteActivity(w: any, m: any): void;
  };
  const w: any = { id: 'w', status: 'running', costUsd: 0, task: 't' };
  run.noteActivity(w, { type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'mcp__foreman__report_progress', input: { status: 'halfway' } },
  ] } });
  assert.equal(w.toolCalls, 1);
  assert.deepEqual(w.recent ?? [], []);
});

// ---------------------------------------------------------------------------
// The sanctioned scratch space and the gitignore hygiene around it
// ---------------------------------------------------------------------------

/** Runs `fn` inside a fresh temp folder and removes it afterwards. */
async function inTempFolder<T>(fn: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'foreman-work-'));
  try {
    return await fn(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('ensureIgnoreLines creates a missing file with exactly the rules', async () => {
  await inTempFolder(async (folder) => {
    const file = path.join(folder, '.gitignore');
    await ensureIgnoreLines(file, ['work/', '.gitignore']);
    assert.equal(await readFile(file, 'utf8'), 'work/\n.gitignore\n');
  });
});

test('ensureIgnoreLines appends only the missing rules and keeps existing content', async () => {
  await inTempFolder(async (folder) => {
    const file = path.join(folder, '.gitignore');
    await writeFile(file, '# mine\nnode_modules/\n  work/  \n');
    await ensureIgnoreLines(file, ['work/', '.gitignore']);
    // `work/` was already there (whitespace around a rule does not make it a
    // different rule), so only `.gitignore` is added — after what was there.
    assert.equal(await readFile(file, 'utf8'), '# mine\nnode_modules/\n  work/  \n.gitignore\n');
  });
});

test('ensureIgnoreLines does not fuse a new rule onto a last line without a newline', async () => {
  await inTempFolder(async (folder) => {
    const file = path.join(folder, '.gitignore');
    await writeFile(file, 'dist');
    await ensureIgnoreLines(file, ['work/']);
    assert.equal(await readFile(file, 'utf8'), 'dist\nwork/\n');
  });
});

test('ensureIgnoreLines leaves a complete file untouched', async () => {
  await inTempFolder(async (folder) => {
    const file = path.join(folder, '.gitignore');
    await writeFile(file, 'work/\n.gitignore\n');
    const before = (await stat(file)).mtimeMs;
    await ensureIgnoreLines(file, ['work/', '.gitignore']);
    assert.equal(await readFile(file, 'utf8'), 'work/\n.gitignore\n');
    assert.equal((await stat(file)).mtimeMs, before);
  });
});

// start() ensures `.foreman/.gitignore` with exactly this call; it is tested
// here directly because start() also launches the director's SDK query.

test('.foreman/.gitignore ignores the directory wholesale, scratch space included', async () => {
  await inTempFolder(async (folder) => {
    await mkdir(path.join(folder, '.foreman'), { recursive: true });
    const file = path.join(folder, '.foreman', '.gitignore');
    await ensureIgnoreLines(file, ['*']);
    assert.equal(await readFile(file, 'utf8'), '*\n');
    // Idempotent across runs: a second start adds nothing.
    await ensureIgnoreLines(file, ['*']);
    assert.equal(await readFile(file, 'utf8'), '*\n');
  });
});

test('a hand-written rule in .foreman/.gitignore survives; "*" is appended, not written over it', async () => {
  await inTempFolder(async (folder) => {
    await mkdir(path.join(folder, '.foreman'), { recursive: true });
    const file = path.join(folder, '.foreman', '.gitignore');
    await writeFile(file, '!MISSION.md\n');
    await ensureIgnoreLines(file, ['*']);
    assert.equal(await readFile(file, 'utf8'), '!MISSION.md\n*\n');
  });
});

test('both charters name the scratch space by path', () => {
  // A place, not a principle: the model needs the literal path. The charters
  // interpolate WORK_DIR, so this also guards against the constant moving
  // without the text following it.
  assert.equal(WORK_DIR, '.foreman/work');
  assert.match(DIRECTOR_CHARTER, /WORK INSIDE THE WORKSPACE/);
  assert.match(WORKER_CHARTER, /WORK INSIDE THE WORKSPACE/);
  assert.ok(DIRECTOR_CHARTER.includes(`${WORK_DIR}/`));
  assert.ok(WORKER_CHARTER.includes(`${WORK_DIR}/`));
  assert.ok(!DIRECTOR_CHARTER.includes('${'), 'WORK_DIR was not interpolated');
});

// ---------------------------------------------------------------------------
// Blocking prompts vs. an autonomous orchestrator (crew-resilience item 8)
// ---------------------------------------------------------------------------

type Pending = PendingPermission & { agent: string };
type Internals = {
  pendingPermissions: Map<string, Pending>;
  allowedRoots: Set<string>;
  runAllowed: Set<string>;
  askTimers: Map<string, unknown>;
  policyFor(agent: string): ReturnType<typeof makePolicy>;
};
const internals = (run: MissionRun) => run as unknown as Internals;
const policyOpts = (signal: AbortSignal, id: string) =>
  ({ signal, toolUseID: id }) as unknown as Parameters<ReturnType<typeof makePolicy>>[2];

test('resolvePermission allow_always on a pending WITH escapedPath grants the path, not the tool, and persists it', () => {
  const events: Array<{ event: string; data: unknown }> = [];
  let saved: RunMeta | undefined;
  const run = new MissionRun(meta(), (event, data) => events.push({ event, data }), (m) => { saved = structuredClone(m); }, noopAgentEnv);
  let result: unknown;
  internals(run).pendingPermissions.set('p1', {
    resolve: (r) => { result = r; }, toolName: 'Bash', escapedPath: '/Users/x/other', agent: 'worker-1',
  });

  assert.equal(run.resolvePermission('p1', 'allow_always'), true);
  assert.deepEqual([...internals(run).allowedRoots], ['/Users/x/other']);
  assert.equal(internals(run).runAllowed.size, 0, 'the tool is NOT granted — that is the re-prompt loop');
  assert.deepEqual(saved?.allowedRoots, ['/Users/x/other'], 'persisted for resume');
  assert.deepEqual(saved?.allowedTools, []);
  assert.deepEqual(result, { behavior: 'allow' }, 'no SDK tool rule rides along with a path grant');
  const rootAllowed = events.find((e) => e.event === 'root_allowed');
  assert.deepEqual(rootAllowed?.data, { path: '/Users/x/other', agent: 'worker-1', toolName: 'Bash' });
  assert.ok(events.some((e) => e.event === 'permission_resolved'));
});

test('resolvePermission allow_always on a pending WITHOUT escapedPath keeps the old meaning: a tool grant', () => {
  const events: Array<{ event: string; data: unknown }> = [];
  let saved: RunMeta | undefined;
  const run = new MissionRun(meta(), (event, data) => events.push({ event, data }), (m) => { saved = structuredClone(m); }, noopAgentEnv);
  let result: unknown;
  internals(run).pendingPermissions.set('p2', { resolve: (r) => { result = r; }, toolName: 'WebFetch', agent: 'director' });

  run.resolvePermission('p2', 'allow_always');
  assert.deepEqual([...internals(run).runAllowed], ['WebFetch']);
  assert.equal(internals(run).allowedRoots.size, 0);
  assert.deepEqual(saved?.allowedTools, ['WebFetch']);
  assert.equal((result as { behavior: string }).behavior, 'allow');
  assert.ok(!events.some((e) => e.event === 'root_allowed'));
});

test('a resumed run rehydrates allowedRoots from meta, and the policy honours them', async () => {
  const run = new MissionRun(meta({ allowedRoots: ['/Users/x/other'], allowedTools: ['WebFetch'] }), () => {}, () => {}, noopAgentEnv);
  assert.deepEqual([...internals(run).allowedRoots], ['/Users/x/other']);
  assert.deepEqual([...internals(run).runAllowed], ['WebFetch']);
  const policy = internals(run).policyFor('director');
  const ac = new AbortController();
  const r = await policy('Write', { file_path: '/Users/x/other/f.txt', content: '' }, policyOpts(ac.signal, 'tu_r'));
  assert.equal(r!.behavior, 'allow', 'a root granted before the restart is not re-asked');
});

test('armAskTimeout fires once after the delay; cancel prevents it; 0 never arms', async () => {
  let fired = 0;
  const a = armAskTimeout(20, () => { fired++; });
  await sleep(60);
  assert.equal(fired, 1);
  a.cancel(); // after firing: harmless
  assert.equal(fired, 1);

  const b = armAskTimeout(20, () => { fired++; });
  b.cancel();
  await sleep(60);
  assert.equal(fired, 1, 'cancelled before firing');

  const c = armAskTimeout(0, () => { fired++; });
  await sleep(30);
  assert.equal(fired, 1, '0 disables');
  c.cancel();
});

test('a pending permission unanswered past the timeout is denied with the unattended message and permission_timeout is emitted', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const run = new MissionRun(meta({ askTimeoutMs: 30 }), (event, data) => events.push({ event, data: data as Record<string, unknown> }), () => {}, noopAgentEnv);
  const policy = internals(run).policyFor('worker-2');
  const ac = new AbortController();
  // Outside the folder (/tmp/x) and NOT a temp dir, so it reaches the ask path.
  const pending = policy('Write', { file_path: '/Users/x/other-repo/f', content: '' }, policyOpts(ac.signal, 'tu_t1'));
  assert.deepEqual(run.pendingPermissionIds, ['tu_t1']);
  assert.equal(internals(run).askTimers.size, 1);

  const r = await pending;
  assert.equal(r!.behavior, 'deny');
  assert.equal((r as { message: string }).message, unattendedDenyMessage(30));
  assert.equal((r as { message: string }).message,
    'Auto-denied after 1 minutes unattended — Foreman does not block a mission on a human who is away. ' +
    'Redo this inside the workspace (.foreman/work/) or record in MISSION.md why the outside is needed.');
  const timeout = events.find((e) => e.event === 'permission_timeout');
  assert.deepEqual(timeout?.data, { id: 'tu_t1', agent: 'worker-2', toolName: 'Write', afterMs: 30 });
  assert.ok(!events.some((e) => e.event === 'permission_resolved'), 'a timeout is not a human decision');
  assert.deepEqual(run.pendingPermissionIds, []);
  assert.equal(internals(run).askTimers.size, 0);
  // Late answers find nothing to answer.
  assert.equal(run.resolvePermission('tu_t1', 'allow'), false);
});

test('a pending permission answered in time is not timed out, and its timer is cleared', async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const run = new MissionRun(meta({ askTimeoutMs: 40 }), (event, data) => events.push({ event, data }), () => {}, noopAgentEnv);
  const policy = internals(run).policyFor('director');
  const ac = new AbortController();
  const pending = policy('Write', { file_path: '/Users/x/other-repo/f', content: '' }, policyOpts(ac.signal, 'tu_t2'));
  assert.equal(run.resolvePermission('tu_t2', 'allow'), true);
  assert.equal((await pending)!.behavior, 'allow');
  assert.equal(internals(run).askTimers.size, 0);
  await sleep(80);
  assert.ok(!events.some((e) => e.event === 'permission_timeout'));
});

test('askTimeoutMs: 0 leaves a pending permission waiting (a babysat run); an abort still settles it', async () => {
  const run = new MissionRun(meta({ askTimeoutMs: 0 }), () => {}, () => {}, noopAgentEnv);
  const policy = internals(run).policyFor('director');
  const ac = new AbortController();
  const pending = policy('Write', { file_path: '/Users/x/other-repo/f', content: '' }, policyOpts(ac.signal, 'tu_t3'));
  await sleep(30);
  assert.deepEqual(run.pendingPermissionIds, ['tu_t3'], 'still waiting');
  ac.abort();
  assert.equal((await pending)!.behavior, 'deny');
  assert.equal(internals(run).askTimers.size, 0);
});

test('the unattended messages and the temp-dir denial say where to go, and the charter carries the rule', () => {
  assert.equal(DEFAULT_ASK_TIMEOUT_MS, 10 * 60_000);
  assert.equal(unattendedAnswer(DEFAULT_ASK_TIMEOUT_MS),
    'No answer after 10 minutes — the human is away. Decide yourself, record the decision and its ' +
    'reasoning in MISSION.md, and continue; do not ask again unless the mission cannot proceed at all.');
  assert.match(unattendedDenyMessage(DEFAULT_ASK_TIMEOUT_MS), /after 10 minutes/);
  assert.ok(DIRECTOR_CHARTER.includes('DECIDE AND RECORD, DON\'T ASK'));
  assert.ok(DIRECTOR_CHARTER.includes('10\n   minutes is auto-answered "decide yourself"') ||
    DIRECTOR_CHARTER.includes('10 minutes is auto-answered "decide yourself"'));
  assert.ok(DIRECTOR_CHARTER.includes('DENIED outright'));
  assert.ok(WORKER_CHARTER.includes('denied outright'));
  assert.ok(!DIRECTOR_CHARTER.includes('prompts the human and stalls'), 'the old sentence is gone');
  assert.ok(!WORKER_CHARTER.includes('prompts the human and stalls'));
});

// ---------------------------------------------------------------------------
// Supervision is not a loop
// ---------------------------------------------------------------------------

test('polling check_workers with identical input never counts as a loop', () => {
  // Fired 27 seconds into the first mixed-provider run: a director calling
  // check_workers five times while a worker built. That is a director doing
  // its job; a second streak would have interrupted a healthy mission.
  let fired = 0;
  const r = watchRepeats(DEFAULT_REPEAT_LIMIT, () => fired++);
  for (let i = 0; i < 20; i++) observeToolUse(r, 'mcp__foreman__check_workers', {});
  for (let i = 0; i < 20; i++) observeToolUse(r, 'mcp__foreman__wait_for_worker', { workerId: 'worker-1' });
  for (let i = 0; i < 20; i++) observeToolUse(r, 'mcp__foreman__report_progress', { status: 'building' });
  assert.equal(fired, 0, 'status reads carry their information in when they are made, not in their input');
  for (const name of REPEAT_EXEMPT) assert.match(name, /^mcp__foreman__/, 'only Foreman’s own supervision tools are exempt');
});

test('a real repeat still fires through the same path', () => {
  // The exemption must not have quietly disabled the detector.
  let fired = 0;
  const r = watchRepeats(3, () => fired++);
  for (let i = 0; i < 3; i++) observeToolUse(r, 'Bash', { command: 'npm test' });
  assert.equal(fired, 1);
});

// ---------------------------------------------------------------------------
// An upstream that states its own cost outranks the rated figure
// ---------------------------------------------------------------------------

test('a ledger-reported cost replaces the rated cost for gateway tokens and arms the cap', async () => {
  const events: Array<{ event: string; data: any }> = [];
  let ledgerCost: number | undefined;
  const run = new MissionRun(
    meta({ costBasis: 'unpriced', budgetUsd: 5 }), (event, data) => events.push({ event, data }), () => {},
    noopAgentEnv, { worker: { input: 0.000002, output: 0.00001 } },
    { key: 'r.0', roles: { director: false, worker: true }, read: async () => ({
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, costUsd: ledgerCost,
    }) },
  ) as unknown as {
    addUsage(raw: unknown, role?: string): void; addCost(usd: number, role?: string): void;
    pollLedger(): Promise<void>; meta: RunMeta;
  };

  // Rated path first: worker tokens priced from the table.
  run.addUsage({ input_tokens: 1000 }, 'worker');
  assert.ok(Math.abs(run.meta.costUsd - 0.002) < 1e-9);
  assert.equal(run.meta.costBasis, 'unpriced', 'a rated figure alone does not change the recorded basis here');

  // Then the upstream states what it actually charged for the same tokens.
  ledgerCost = 0.0031;
  await run.pollLedger();
  assert.ok(Math.abs(run.meta.costUsd - 0.0031) < 1e-9, `the bill-sender's figure replaces the rated one, got ${run.meta.costUsd}`);
  assert.equal(run.meta.costBasis, 'priced');
  assert.ok(events.some((e) => e.event === 'settings_changed' && /now priced/.test(e.data.changes?.[0] ?? '')),
    'the flip to priced is announced, because the dollar cap arms with it');
  assert.deepEqual(run.meta.costParts, { native: 0, rated: 0.002, ledger: 0.0031 });

  // Native (Anthropic) cost still adds on top; it prices different tokens.
  run.addCost(0.5, 'director');
  assert.ok(Math.abs(run.meta.costUsd - 0.5031) < 1e-9);
});

test('a resumed run adds this attempt’s ledger cost to what earlier attempts persisted', async () => {
  const run = new MissionRun(
    meta({ costBasis: 'priced', costUsd: 1.25, costParts: { native: 0.25, rated: 0, ledger: 1.0 } }),
    () => {}, () => {}, noopAgentEnv, {},
    { key: 'r.1', roles: { director: false, worker: true }, read: async () => ({
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, costUsd: 0.4,
    }) },
  ) as unknown as { pollLedger(): Promise<void>; meta: RunMeta };
  await run.pollLedger();
  assert.ok(Math.abs(run.meta.costUsd - 1.65) < 1e-9, `0.25 native + (1.0 earlier + 0.4 now), got ${run.meta.costUsd}`);
});

// ---------------------------------------------------------------------------
// Item 6: a stalled gateway worker asks the human, with the retry one tap away
// ---------------------------------------------------------------------------

function fallbackRun(over: Partial<RunMeta>, roleBasis?: { director: 'priced' | 'free' | 'unpriced'; worker: 'priced' | 'free' | 'unpriced' }) {
  const events: Array<{ event: string; data: any }> = [];
  const launched: any[] = [];
  const directorEnv = { env: { A: 'director' } } as unknown as AgentEnv;
  const workerEnv = { env: { A: 'worker' } } as unknown as AgentEnv;
  const run = new MissionRun(
    meta({ directorModel: 'sonnet', workerModel: 'glm-5.3-flash:cloud', costBasis: 'free', askTimeoutMs: 20, ...over }),
    (event, data) => events.push({ event, data }), () => {},
    { director: directorEnv, worker: workerEnv }, {}, undefined, roleBasis,
  ) as unknown as {
    askFallback(id: string, prompt: string, out: { report: string; isError: boolean }, why: string): Promise<{ report: string; isError: boolean }>;
    launchWorker(...a: unknown[]): unknown;
    answerQuestion(id: string, text: string): boolean;
    meta: RunMeta;
  };
  run.launchWorker = (...a: unknown[]) => { launched.push(a); return {}; };
  return { run, events, launched, directorEnv };
}

test('the human taps retry: the brief relaunches on the director’s provider and the basis flips, announced', async () => {
  const { run, events, launched, directorEnv } = fallbackRun({ askTimeoutMs: 60_000 }, { director: 'priced', worker: 'free' });
  const p = run.askFallback('worker-1', 'build the page', { report: 'WORKER STALLED…', isError: true }, 'stalled');
  await new Promise((r) => setTimeout(r, 10));
  const q = events.find((e) => e.event === 'question');
  assert.ok(q, 'the human is asked');
  assert.equal(q!.data.options.length, 2);
  assert.match(q!.data.options[1], /Retry once on the director's provider \(sonnet\)/);
  assert.equal(run.answerQuestion(q!.data.id, q!.data.options[1]), true);
  const out = await p;
  assert.equal(launched.length, 1, 'relaunched exactly once');
  const [id, prompt, resume, overrides] = launched[0] as [string, string, undefined, any];
  assert.match(id, /^worker-\d+$/);
  assert.equal(prompt, 'build the page');
  assert.equal(resume, undefined);
  assert.equal(overrides.env, directorEnv);
  assert.equal(overrides.model, 'sonnet');
  assert.equal(overrides.priceRole, 'director');
  assert.equal(run.meta.costBasis, 'priced', 'free worker → priced director: the run is priced now');
  assert.ok(events.some((e) => e.event === 'settings_changed' && /now priced/.test(e.data.changes[0])), 'and it is announced');
  assert.match(out.report, /THE HUMAN CHOSE TO RETRY/);
  assert.match(out.report, new RegExp(`running as ${id}`));
});

test('nobody answers: after the timeout the director simply continues, nothing is relaunched', async () => {
  const { run, events, launched } = fallbackRun({}, { director: 'priced', worker: 'free' });
  const out = await run.askFallback('worker-1', 'brief', { report: 'WORKER STALLED…', isError: true }, 'stalled');
  assert.equal(launched.length, 0);
  assert.equal(out.report, 'WORKER STALLED…', 'the outcome is handed back unchanged');
  assert.ok(events.some((e) => e.event === 'question_timeout'));
  assert.equal(run.meta.costBasis, 'free', 'no money was committed on the human’s behalf');
});

test('a worker already on the director’s provider is not asked — there is nowhere else to go', async () => {
  const { run, events, launched } = fallbackRun({ directorModel: 'sonnet', workerModel: 'sonnet' }, { director: 'priced', worker: 'priced' });
  (run as any).agentEnv.worker = (run as any).agentEnv.director;
  const out = await run.askFallback('worker-1', 'brief', { report: 'r', isError: true }, 'looping');
  assert.equal(events.filter((e) => e.event === 'question').length, 0);
  assert.equal(launched.length, 0);
  assert.equal(out.report, 'r');
  // And with no role bases known at all, likewise.
  const bare = fallbackRun({});
  await bare.run.askFallback('worker-1', 'brief', { report: 'r', isError: true }, 'stalled');
  assert.equal(bare.events.filter((e) => e.event === 'question').length, 0);
});

test('the SDK’s dollar figure is discarded for a gateway role — it prices the wrong tokens', () => {
  // "$30.14" on a fleet card for a run on free and unpriced models: Anthropic's
  // table applied to 5.8M Ollama tokens. Stopped where it is recorded.
  const run = new MissionRun(meta({ costBasis: 'unpriced' }), () => {}, () => {}, noopAgentEnv, {},
    { key: 'r.0', roles: { director: true, worker: true }, read: async () => null },
  ) as unknown as { addCost(usd: number, role?: string): void; meta: RunMeta };
  run.addCost(30.14, 'director');
  run.addCost(1.5, 'worker');
  assert.equal(run.meta.costUsd, 0);
  // A native role's figure is still real and still counted.
  const mixed = new MissionRun(meta({ costBasis: 'priced' }), () => {}, () => {}, noopAgentEnv, {},
    { key: 'r.0', roles: { director: false, worker: true }, read: async () => null },
  ) as unknown as { addCost(usd: number, role?: string): void; meta: RunMeta };
  mixed.addCost(0.4, 'director');
  mixed.addCost(9, 'worker');
  assert.equal(mixed.meta.costUsd, 0.4);
});

test('pendingAsks exposes an open question with its text and options, and forgets it once answered', async () => {
  // The fleet board and a phone answer asks away from the transcript; they
  // need what the ask *is*, not just that one exists.
  const events: Array<{ event: string; data: any }> = [];
  const directorEnv = { env: { A: 'd' } } as unknown as AgentEnv;
  const workerEnv = { env: { A: 'w' } } as unknown as AgentEnv;
  const run = new MissionRun(
    meta({ directorModel: 'sonnet', workerModel: 'glm', costBasis: 'free', askTimeoutMs: 60_000 }),
    (event, data) => events.push({ event, data }), () => {},
    { director: directorEnv, worker: workerEnv }, {}, undefined, { director: 'priced', worker: 'free' },
  ) as unknown as {
    askFallback(id: string, prompt: string, out: { report: string; isError: boolean }, why: string): Promise<unknown>;
    pendingAsks(): Array<{ id: string; kind: string; text: string; options?: string[]; since: number }>;
    answerQuestion(id: string, text: string): boolean;
  };
  const p = run.askFallback('worker-1', 'brief', { report: 'stalled', isError: true }, 'stalled');
  await new Promise((r) => setTimeout(r, 10));
  const open = run.pendingAsks();
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'question');
  assert.match(open[0].text, /worker-1 stalled/);
  assert.equal(open[0].options?.length, 2);
  assert.ok(Date.now() - open[0].since < 5000);
  run.answerQuestion(open[0].id, open[0].options![0]);
  await p;
  assert.deepEqual(run.pendingAsks(), []);
});
