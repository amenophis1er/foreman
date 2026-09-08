import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { frozenDeck, frozenMissionDoc, hasSnapshot, restoreMissionDoc, snapshotRun } from './snapshot.js';

async function site() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'foreman-snap-'));
  const folder = path.join(root, 'proj'); const runDir = path.join(root, 'runs', 'r1');
  await mkdir(path.join(folder, '.foreman'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  return { root, folder, runDir };
}

test('snapshotRun freezes the mission doc and a deck beside the run, and reads them back', async () => {
  const { root, folder, runDir } = await site();
  await writeFile(path.join(folder, '.foreman', 'MISSION.md'), '# Mission A\n- [x] done\n');
  await writeFile(path.join(folder, 'a.txt'), 'hello\n');
  const r = await snapshotRun(runDir, folder, 'r1', 1234);
  assert.deepEqual(r, { doc: true, deck: true });
  assert.equal(await frozenMissionDoc(runDir), '# Mission A\n- [x] done\n');
  const deck = await frozenDeck(runDir);
  assert.equal(deck?.frozenAt, 1234);
  assert.match(deck?.note ?? '', /As the folder stood when the run ended/);
  assert.equal(await hasSnapshot(runDir), true);
  // A later mission overwrites the folder's doc; the record does not move.
  await writeFile(path.join(folder, '.foreman', 'MISSION.md'), '# Mission B\n');
  assert.equal(await frozenMissionDoc(runDir), '# Mission A\n- [x] done\n');
  await rm(root, { recursive: true, force: true });
});

test('restoreMissionDoc puts the run\'s own doc back, and says whether it had to', async () => {
  const { root, folder, runDir } = await site();
  assert.equal(await restoreMissionDoc(runDir, folder), 'none', 'no record yet');
  await writeFile(path.join(runDir, 'MISSION.md'), '# Mission A\n');
  await writeFile(path.join(folder, '.foreman', 'MISSION.md'), '# Mission B\n');
  assert.equal(await restoreMissionDoc(runDir, folder), 'restored');
  assert.equal(await readFile(path.join(folder, '.foreman', 'MISSION.md'), 'utf8'), '# Mission A\n');
  assert.equal(await restoreMissionDoc(runDir, folder), 'same');
  await rm(root, { recursive: true, force: true });
});

test('a run with no mission doc still freezes its deck; a missing folder freezes nothing and does not throw', async () => {
  const { root, folder, runDir } = await site();
  const r = await snapshotRun(runDir, folder, 'r1');
  assert.equal(r.doc, false);
  assert.equal(await hasSnapshot(runDir), r.deck);
  const gone = await snapshotRun(path.join(root, 'runs', 'r2'), path.join(root, 'nowhere'), 'r2');
  assert.equal(gone.doc, false);
  assert.equal(await hasSnapshot(path.join(root, 'runs', 'r2')), gone.deck);
  await rm(root, { recursive: true, force: true });
});
