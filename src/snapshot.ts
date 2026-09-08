/**
 * What a finished run said, kept with the run.
 *
 * `.foreman/MISSION.md` is one file per project folder and every mission
 * writes it, and the deck is a live diff of the folder against the run's
 * baseline. Both were read fresh whenever a run was looked at — so the moment
 * a newer mission started in the same project, every older run's page, its
 * `run_report` and its resume were reading the new mission's doc and a diff
 * that kept growing with later work. A resume of an older interrupted run
 * handed its director the wrong mission outright.
 *
 * So a run's record freezes when the run ends: its MISSION.md and a summary
 * of its deck are copied into `~/.foreman/runs/<id>/`. Finished runs are read
 * from the copy; a running run still reads the live folder. On resume the
 * copy goes back into the folder first, so the director picks up its own
 * mission. Diffs in the frozen deck are capped so a record stays a record,
 * not an archive of the repository.
 */
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import { deckFor, type Deck } from './deck.js';

export const SNAPSHOT_DOC = 'MISSION.md';
export const SNAPSHOT_DECK = 'deck.json';
/** A single file's diff kept in the frozen deck; longer ones are cut with a note. */
const DIFF_CAP = 20_000;

export interface FrozenDeck extends Deck {
  /** When the run ended and this was taken. */
  frozenAt: number;
}

const missionDocPath = (folder: string) => path.join(folder, '.foreman', 'MISSION.md');

async function writeAtomic(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, body);
  await rename(tmp, file);
}

/** Copies the run's mission doc and deck into `runDir`. Never throws; a missing doc is simply not copied. */
export async function snapshotRun(runDir: string, folder: string, runId: string, now = Date.now()): Promise<{ doc: boolean; deck: boolean }> {
  let doc = false; let deck = false;
  const text = await readFile(missionDocPath(folder), 'utf8').catch(() => null);
  if (text !== null) {
    await writeAtomic(path.join(runDir, SNAPSHOT_DOC), text).then(() => { doc = true; }).catch(() => {});
  }
  const live = await deckFor(folder, runId).catch(() => null);
  if (live) {
    const frozen: FrozenDeck = {
      ...live,
      frozenAt: now,
      files: live.files.map((f) => (f.diff && f.diff.length > DIFF_CAP
        ? { ...f, diff: `${f.diff.slice(0, DIFF_CAP)}\n… diff cut at ${DIFF_CAP} characters in the run's record`, truncated: true }
        : f)),
      note: [live.note, 'As the folder stood when the run ended.'].filter(Boolean).join(' '),
    };
    await writeAtomic(path.join(runDir, SNAPSHOT_DECK), JSON.stringify(frozen)).then(() => { deck = true; }).catch(() => {});
  }
  return { doc, deck };
}

/** The frozen doc, or null when this run has none (older runs, or nothing was written). */
export async function frozenMissionDoc(runDir: string): Promise<string | null> {
  return readFile(path.join(runDir, SNAPSHOT_DOC), 'utf8').catch(() => null);
}

/** The frozen deck, or null. */
export async function frozenDeck(runDir: string): Promise<FrozenDeck | null> {
  const raw = await readFile(path.join(runDir, SNAPSHOT_DECK), 'utf8').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as FrozenDeck; } catch { return null; }
}

/**
 * Puts the run's own mission doc back into the folder before a resume, so the
 * director reads its mission and not whichever one ran last. Returns what
 * happened, for the transcript: `restored` when the folder's doc differed,
 * `same` when it already matched, `none` when this run has no copy.
 */
export async function restoreMissionDoc(runDir: string, folder: string): Promise<'restored' | 'same' | 'none'> {
  const frozen = await frozenMissionDoc(runDir);
  if (frozen === null) return 'none';
  const current = await readFile(missionDocPath(folder), 'utf8').catch(() => null);
  if (current === frozen) return 'same';
  await writeAtomic(missionDocPath(folder), frozen);
  return 'restored';
}

/**
 * A new run starts with no mission doc in the folder. The previous run's
 * MISSION.md would otherwise sit there until the new director rewrites it,
 * and everything reading the folder — run_status, the fleet card, the rail —
 * showed the old DONE WHEN, ticked, on a run that had just begun. The old doc
 * is kept: copied into the previous run's record when that run has no copy
 * yet (runs from before records were frozen), then removed from the folder.
 */
export async function parkMissionDoc(folder: string, previousRunDir: string | null): Promise<'parked' | 'none'> {
  const file = missionDocPath(folder);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return 'none';
  if (previousRunDir && (await frozenMissionDoc(previousRunDir)) === null) {
    await writeAtomic(path.join(previousRunDir, SNAPSHOT_DOC), text).catch(() => {});
  }
  await unlink(file).catch(() => {});
  return 'parked';
}

/** Does the run have a frozen record at all? */
export async function hasSnapshot(runDir: string): Promise<boolean> {
  const doc = await stat(path.join(runDir, SNAPSHOT_DOC)).then(() => true, () => false);
  if (doc) return true;
  return stat(path.join(runDir, SNAPSHOT_DECK)).then(() => true, () => false);
}
