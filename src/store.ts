/**
 * RunStore — durable, append-only persistence for Foreman runs.
 *
 * Layout (default root: ~/.foreman):
 *
 *   <root>/runs/<runId>/meta.json     — RunMeta, rewritten atomically on change
 *   <root>/runs/<runId>/events.jsonl  — one ForemanEvent per line, append-only
 *
 * Design notes for reviewers:
 *  - The event log is the source of truth for the UI; meta.json is a derived
 *    summary kept small so listing runs never reads event logs.
 *  - meta.json writes go through tmp-file + rename so a crash mid-write can
 *    never corrupt an existing file.
 *  - Event appends are serialized per store instance through a promise chain,
 *    preserving emit order even when callers don't await.
 *  - {@link sweepOrphans} reconciles runs left in status "running" by a
 *    previous process: it appends a synthetic `run_finished` event and marks
 *    the run interrupted, so replaying a log always terminates cleanly.
 */
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ForemanEvent, RunMeta, RunSummary } from './types.js';

const RUN_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

/** Sortable, collision-safe run id: `<ms since epoch>-<random hex>`. */
export function newRunId(now = Date.now()): string {
  return `${String(now).padStart(13, '0')}-${crypto.randomBytes(4).toString('hex')}`;
}

export class RunStore {
  private readonly runsDir: string;
  /** Serializes appends per run so event order matches emit order. */
  private appendChains = new Map<string, Promise<void>>();

  constructor(root: string = path.join(os.homedir(), '.foreman')) {
    this.runsDir = path.join(root, 'runs');
  }

  private runDir(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id: ${runId}`);
    return path.join(this.runsDir, runId);
  }

  /** Creates the run directory and writes initial metadata. */
  async createRun(meta: RunMeta): Promise<void> {
    await mkdir(this.runDir(meta.id), { recursive: true });
    await this.writeMeta(meta);
  }

  /** Atomically replaces meta.json (tmp + rename). */
  async writeMeta(meta: RunMeta): Promise<void> {
    const dir = this.runDir(meta.id);
    const tmp = path.join(dir, `.meta.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, path.join(dir, 'meta.json'));
  }

  /**
   * Appends one event to the run's log. Returns a promise that resolves when
   * the line is on disk; callers may fire-and-forget — order is preserved.
   */
  append(runId: string, event: ForemanEvent): Promise<void> {
    const file = path.join(this.runDir(runId), 'events.jsonl');
    const prev = this.appendChains.get(runId) ?? Promise.resolve();
    const next = prev.then(() => appendFile(file, JSON.stringify(event) + '\n'));
    // Keep the chain alive even if one append fails; the failure still
    // surfaces to the caller awaiting `next`.
    this.appendChains.set(runId, next.catch(() => {}));
    return next;
  }

  async readMeta(runId: string): Promise<RunMeta | null> {
    const raw = await readFile(path.join(this.runDir(runId), 'meta.json'), 'utf8')
      .catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RunMeta;
    } catch {
      return null; // unreadable meta is treated as missing, never fatal
    }
  }

  /** Reads the full event log; skips lines that fail to parse (torn writes). */
  async readEvents(runId: string): Promise<ForemanEvent[]> {
    const raw = await readFile(path.join(this.runDir(runId), 'events.jsonl'), 'utf8')
      .catch(() => '');
    const events: ForemanEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as ForemanEvent);
      } catch {
        // A torn final line after a crash is expected; drop it.
      }
    }
    return events;
  }

  /** Lists all runs, newest first. Reads only meta.json files. */
  async listRuns(): Promise<RunSummary[]> {
    const ids = await readdir(this.runsDir).catch(() => [] as string[]);
    const metas = await Promise.all(
      ids.filter((id) => RUN_ID_RE.test(id)).map((id) => this.readMeta(id)),
    );
    return metas
      .filter((m): m is RunMeta => m !== null)
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  /**
   * Marks runs left in status "running" by a dead process as interrupted,
   * appending a synthetic `run_finished` so replayed logs terminate cleanly.
   * Returns the ids of swept runs.
   */
  async sweepOrphans(): Promise<string[]> {
    const swept: string[] = [];
    for (const meta of await this.listRuns()) {
      if (meta.status !== 'running') continue;
      const ended: RunMeta = { ...meta, status: 'interrupted', endedAt: Date.now() };
      await this.append(meta.id, {
        ts: Date.now(),
        event: 'run_finished',
        data: { status: 'interrupted', costUsd: meta.costUsd, reason: 'server restarted' },
      });
      await this.writeMeta(ended);
      swept.push(meta.id);
    }
    return swept;
  }
}
