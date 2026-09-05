import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  DEFAULT_REPEAT_LIMIT, MissionRun, accumulateUsage, loopingWorkerReport, stalledWorkerReport,
  watchRepeats, watchSilence,
} from './orchestrator.js';
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
