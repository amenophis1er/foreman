import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStore, newRunId } from './store.js';
import type { RunMeta, Schedule } from './types.js';

function meta(id: string, over: Partial<RunMeta> = {}): RunMeta {
  return {
    id, folder: '/tmp/x', mission: 'test', budgetUsd: 5,
    status: 'running', costUsd: 0, createdAt: Date.now(), workers: [],
    ...over,
  };
}

async function tmpStore(): Promise<{ store: RunStore; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-store-'));
  return { store: new RunStore(root), root };
}

test('newRunId is sortable by creation time and well-formed', () => {
  const a = newRunId(1000);
  const b = newRunId(2000);
  assert.match(a, /^[0-9]{13}-[0-9a-f]{8}$/);
  assert.ok(a < b);
});

test('create, append, read round-trip preserves order', async () => {
  const { store, root } = await tmpStore();
  const id = newRunId();
  await store.createRun(meta(id));
  // Fire-and-forget appends must still land in order.
  for (let i = 0; i < 20; i++) void store.append(id, { ts: i, event: 'e', data: { i } });
  await store.append(id, { ts: 99, event: 'last', data: null });

  const events = await store.readEvents(id);
  assert.equal(events.length, 21);
  assert.deepEqual(events.map((e) => e.ts).slice(0, 5), [0, 1, 2, 3, 4]);
  assert.equal(events.at(-1)?.event, 'last');
  await rm(root, { recursive: true, force: true });
});

test('listRuns returns newest first and skips junk', async () => {
  const { store, root } = await tmpStore();
  const a = newRunId(1000);
  const b = newRunId(2000);
  await store.createRun(meta(a));
  await store.createRun(meta(b));
  const runs = await store.listRuns();
  assert.deepEqual(runs.map((r) => r.id), [b, a]);
  await rm(root, { recursive: true, force: true });
});

test('sweepOrphans finishes running runs and appends a terminal event', async () => {
  const { store, root } = await tmpStore();
  const orphan = newRunId(1000);
  const finished = newRunId(2000);
  await store.createRun(meta(orphan));
  await store.createRun(meta(finished, { status: 'done' }));

  const swept = await store.sweepOrphans();
  assert.deepEqual(swept, [orphan]);

  const m = await store.readMeta(orphan);
  assert.equal(m?.status, 'interrupted');
  assert.ok(m?.endedAt);
  const events = await store.readEvents(orphan);
  assert.equal(events.at(-1)?.event, 'run_finished');

  // Idempotent: nothing left to sweep.
  assert.deepEqual(await store.sweepOrphans(), []);
  await rm(root, { recursive: true, force: true });
});

test('readEvents drops a torn trailing line', async () => {
  const { store, root } = await tmpStore();
  const id = newRunId();
  await store.createRun(meta(id));
  await store.append(id, { ts: 1, event: 'ok', data: null });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path.join(root, 'runs', id, 'events.jsonl'), '{"ts":2,"event":"torn'); // no newline, invalid JSON
  const events = await store.readEvents(id);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ok');
  await rm(root, { recursive: true, force: true });
});

test('run ids are validated before touching the filesystem', async () => {
  const { store } = await tmpStore();
  await assert.rejects(() => store.readEvents('../../etc/passwd' as string));
});

test('projects: add is idempotent per folder, remove keeps others', async () => {
  const { store, root } = await tmpStore();
  const a = await store.addProject('/tmp/proj-a');
  const b = await store.addProject('/tmp/proj-b', 'Custom Name');
  const aAgain = await store.addProject('/tmp/proj-a');

  assert.equal(a.id, aAgain.id);
  assert.equal(a.name, 'proj-a');
  assert.equal(b.name, 'Custom Name');
  assert.equal((await store.listProjects()).length, 2);
  assert.deepEqual(await store.getProject(a.id), a);

  assert.equal(await store.removeProject(a.id), true);
  assert.equal(await store.removeProject(a.id), false);
  assert.deepEqual((await store.listProjects()).map((p) => p.id), [b.id]);
  await rm(root, { recursive: true, force: true });
});

test('projects: concurrent adds do not lose writes', async () => {
  const { store, root } = await tmpStore();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.addProject(`/tmp/conc-${i}`)),
  );
  assert.equal((await store.listProjects()).length, 8);
  await rm(root, { recursive: true, force: true });
});

test('archiveChat retires a conversation: gone from the project, kept on disk, and idempotent', async () => {
  const { store, root } = await tmpStore();
  await store.appendChat('p-abc', { ts: 1, event: 'chat_message', data: { text: 'hi' } });
  await store.writeChatMeta({ projectId: 'p-abc', costUsd: 1, createdAt: 1, updatedAt: 1 });
  assert.deepEqual(await store.listChatIds(), ['p-abc']);

  await store.archiveChat('p-abc', '1700000000000-deadbeef');
  assert.deepEqual(await store.listChatIds(), []);
  assert.equal(await store.readChatMeta('p-abc'), null);
  assert.deepEqual(await store.readChatEvents('p-abc'), []);
  const archived = path.join(root, 'chats', '_archive', 'p-abc-1700000000000-deadbeef', 'events.jsonl');
  assert.ok((await import('node:fs/promises')).readFile(archived, 'utf8'));

  // Nothing to archive is not an error.
  await store.archiveChat('p-abc', 'again');
  await rm(root, { recursive: true, force: true });
});


test('sweepOrphans leaves a running run alone while another live process owns it', async () => {
  const { store, root } = await tmpStore();
  const mine = newRunId(1000); const theirs = newRunId(2000); const dead = newRunId(3000);
  await store.createRun(meta(mine, { ownerPid: process.pid }));
  // The test runner's parent is alive and is not us.
  await store.createRun(meta(theirs, { ownerPid: process.ppid }));
  await store.createRun(meta(dead, { ownerPid: 2 ** 22 - 7 }));
  const swept = await store.sweepOrphans();
  assert.ok(swept.includes(mine), 'our own record from a previous life is swept');
  assert.ok(swept.includes(dead), 'a dead owner is an orphan');
  assert.ok(!swept.includes(theirs), 'a live foreign owner keeps its run');
  assert.equal((await store.readMeta(theirs))!.status, 'running');
  await rm(root, { recursive: true, force: true });
});

function schedule(over: Partial<Schedule> = {}): Omit<Schedule, 'id' | 'createdAt'> & { createdAt?: number } {
  return {
    projectId: 'p-1', name: 'nightly', brief: 'tidy the tests', budgetUsd: 3,
    cadence: { kind: 'daily', at: '03:00' } as unknown as Schedule['cadence'],
    enabled: true, nextRunAt: 1000, consecutiveFailures: 0, pausedReason: null,
    ...over,
  };
}

test('schedules: add generates an id, list is per project and oldest first', async () => {
  const { store, root } = await tmpStore();
  const a = await store.addSchedule(schedule({ createdAt: 2000 }));
  const b = await store.addSchedule(schedule({ createdAt: 1000, name: 'weekly' }));
  const other = await store.addSchedule(schedule({ projectId: 'p-2' }));

  assert.match(a.id, /^s-[0-9a-f]{12}$/);
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await store.listSchedules()).map((s) => s.id), [b.id, a.id, other.id]);
  assert.deepEqual((await store.listSchedules('p-1')).map((s) => s.name), ['weekly', 'nightly']);
  assert.deepEqual(await store.getSchedule(a.id), a);
  assert.equal(await store.getSchedule('s-missing'), null);
  await rm(root, { recursive: true, force: true });
});

test('schedules: update merges, and null clears where undefined leaves alone', async () => {
  const { store, root } = await tmpStore();
  const s = await store.addSchedule(schedule({ pausedReason: 'failures', consecutiveFailures: 3 }));

  const paused = await store.updateSchedule(s.id, { lastOutcome: 'error' });
  assert.equal(paused?.pausedReason, 'failures', 'an absent key is left alone');
  assert.equal(paused?.lastOutcome, 'error');

  const resumed = await store.updateSchedule(s.id, {
    pausedReason: null, nextRunAt: null, consecutiveFailures: 0,
  });
  assert.equal(resumed?.pausedReason, null);
  assert.equal(resumed?.nextRunAt, null);
  assert.equal(resumed?.consecutiveFailures, 0);
  // And it survived the write, not just the returned object.
  assert.equal((await store.getSchedule(s.id))?.nextRunAt, null);

  assert.equal(await store.updateSchedule('s-missing', { enabled: false }), null);
  await rm(root, { recursive: true, force: true });
});

test('schedules: remove reports whether it existed', async () => {
  const { store, root } = await tmpStore();
  const a = await store.addSchedule(schedule());
  const b = await store.addSchedule(schedule({ name: 'other' }));
  assert.equal(await store.removeSchedule(a.id), true);
  assert.equal(await store.removeSchedule(a.id), false);
  assert.deepEqual((await store.listSchedules()).map((s) => s.id), [b.id]);
  await rm(root, { recursive: true, force: true });
});

test('schedules: unlinking a project takes its schedules with it', async () => {
  const { store, root } = await tmpStore();
  const p = await store.addProject('/tmp/sched-proj');
  const q = await store.addProject('/tmp/other-proj');
  await store.addSchedule(schedule({ projectId: p.id }));
  await store.addSchedule(schedule({ projectId: p.id, name: 'second' }));
  const keep = await store.addSchedule(schedule({ projectId: q.id }));

  assert.equal(await store.removeProject(p.id), true);
  assert.deepEqual((await store.listSchedules()).map((s) => s.id), [keep.id]);
  assert.deepEqual(await store.listSchedules(p.id), []);
  await rm(root, { recursive: true, force: true });
});

test('schedules: a corrupt schedules.json reads as empty rather than throwing', async () => {
  const { store, root } = await tmpStore();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root, 'schedules.json'), '{not json');
  assert.deepEqual(await store.listSchedules(), []);
  // And a write over it recovers the file.
  const s = await store.addSchedule(schedule());
  assert.deepEqual((await store.listSchedules()).map((x) => x.id), [s.id]);
  await rm(root, { recursive: true, force: true });
});
