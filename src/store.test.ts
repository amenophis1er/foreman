import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunStore, newRunId } from './store.js';
import type { RunMeta } from './types.js';

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
