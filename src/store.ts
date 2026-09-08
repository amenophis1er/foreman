/**
 * RunStore — durable, append-only persistence for Foreman runs.
 *
 * Layout (default root: ~/.foreman):
 *
 *   <root>/runs/<runId>/meta.json     — RunMeta, rewritten atomically on change
 *   <root>/runs/<runId>/events.jsonl  — one ForemanEvent per line, append-only
 *   <root>/chats/<projectId>/…        — same two files for a project's
 *                                       planning conversation
 *   <root>/schedules.json             — every Schedule, one JSON array
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
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ChatMeta, ForemanEvent, Project, ProviderRef, RunMeta, RunSummary, Schedule, SettingsFile,
} from './types.js';

const RUN_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

/** Sortable, collision-safe run id: `<ms since epoch>-<random hex>`. */
export function newRunId(now = Date.now()): string {
  return `${String(now).padStart(13, '0')}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Is a process with this pid alive? Signal 0 checks without sending anything. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    // EPERM means it exists but is not ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class RunStore {
  /** Absolute data root; exposed so startup checks can report and test it. */
  readonly root: string;
  private readonly runsDir: string;
  private readonly chatsDir: string;
  /** Serializes appends per run so event order matches emit order. */
  private appendChains = new Map<string, Promise<void>>();
  /** Serializes projects.json rewrites. */
  private projectsChain: Promise<unknown> = Promise.resolve();

  constructor(root: string = path.join(os.homedir(), '.foreman')) {
    this.root = root;
    this.runsDir = path.join(root, 'runs');
    this.chatsDir = path.join(root, 'chats');
  }

  // -- projects -------------------------------------------------------------

  private get projectsFile(): string {
    return path.join(this.root, 'projects.json');
  }

  async listProjects(): Promise<Project[]> {
    const raw = await readFile(this.projectsFile, 'utf8').catch(() => null);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Project[]) : [];
    } catch {
      return [];
    }
  }

  /** Atomically rewrites projects.json through `mutate`; returns its result. */
  private mutateProjects<T>(mutate: (projects: Project[]) => { projects: Project[]; result: T }): Promise<T> {
    const task = this.projectsChain.then(async () => {
      const { projects, result } = mutate(await this.listProjects());
      await mkdir(this.root, { recursive: true });
      const tmp = path.join(this.root, `.projects.${crypto.randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, JSON.stringify(projects, null, 2));
      await rename(tmp, this.projectsFile);
      return result;
    });
    this.projectsChain = task.catch(() => {});
    return task;
  }

  /** Links a folder as a project. Re-linking an already-linked folder returns
   *  the existing project instead of duplicating it. */
  /**
   * Applies a partial change to one project. `provider: null` clears the pin
   * (back to the server default) — distinct from `undefined`, which means
   * "leave it alone", so the settings form can express both.
   */
  updateProject(
    id: string,
    patch: { name?: string; defaultBudgetUsd?: number; provider?: ProviderRef | null },
  ): Promise<Project | null> {
    return this.mutateProjects((projects) => {
      const i = projects.findIndex((p) => p.id === id);
      if (i === -1) return { projects, result: null };

      const next: Project = { ...projects[i] };
      if (patch.name?.trim()) next.name = patch.name.trim();
      if (typeof patch.defaultBudgetUsd === 'number' && patch.defaultBudgetUsd > 0) {
        next.defaultBudgetUsd = patch.defaultBudgetUsd;
      }
      if (patch.provider === null) {
        delete next.provider;
        // Drop the pre-provider pin too, or clearing would silently fall back
        // to it through providerOf().
        delete next.claudeInstance;
      } else if (patch.provider) {
        next.provider = patch.provider;
        delete next.claudeInstance;
      }

      const updated = [...projects];
      updated[i] = next;
      return { projects: updated, result: next };
    });
  }

  addProject(folder: string, name?: string, provider?: ProviderRef): Promise<Project> {
    return this.mutateProjects((projects) => {
      const existing = projects.find((p) => p.folder === folder);
      if (existing) return { projects, result: existing };
      const project: Project = {
        id: `p-${crypto.randomBytes(6).toString('hex')}`,
        name: name?.trim() || path.basename(folder),
        folder,
        createdAt: Date.now(),
        defaultBudgetUsd: 5,
        ...(provider ? { provider } : {}),
      };
      return { projects: [...projects, project], result: project };
    });
  }

  /** Unlinks a project (run history is kept). Returns whether it existed. */
  async removeProject(projectId: string): Promise<boolean> {
    const existed = await this.mutateProjects((projects) => {
      const rest = projects.filter((p) => p.id !== projectId);
      return { projects: rest, result: rest.length !== projects.length };
    });
    // Its schedules go with it: a standing instruction to run missions in a
    // folder Foreman no longer knows about has nowhere to fire. Sequential and
    // not nested inside the mutate, because both writes share one chain.
    await this.removeProjectSchedules(projectId);
    return existed;
  }

  async getProject(projectId: string): Promise<Project | null> {
    return (await this.listProjects()).find((p) => p.id === projectId) ?? null;
  }

  // -- settings -------------------------------------------------------------

  private get settingsFile(): string {
    return path.join(this.root, 'settings.json');
  }

  /** Reads persisted settings: a global object plus per-project overlays. */
  async readSettings(): Promise<SettingsFile> {
    const raw = await readFile(this.settingsFile, 'utf8').catch(() => null);
    if (!raw) return { global: {}, projects: {} };
    try {
      const parsed = JSON.parse(raw) as Partial<SettingsFile>;
      return { global: parsed.global ?? {}, projects: parsed.projects ?? {} };
    } catch {
      return { global: {}, projects: {} };
    }
  }

  /** Atomically replaces settings.json (serialized like projects.json). */
  writeSettings(settings: SettingsFile): Promise<void> {
    const task = this.projectsChain.then(async () => {
      await mkdir(this.root, { recursive: true });
      const tmp = path.join(this.root, `.settings.${crypto.randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, JSON.stringify(settings, null, 2));
      await rename(tmp, this.settingsFile);
    });
    this.projectsChain = task.catch(() => {});
    return task;
  }

  // -- schedules ------------------------------------------------------------

  /**
   * Every schedule lives in one small file, not a directory per schedule:
   * there are a handful of them, the ticker reads all of them on every tick to
   * decide what is due, and a single array is one read and one atomic write.
   * It shares `projectsChain` with projects.json and settings.json so a write
   * here can never interleave with one of those.
   */
  private get schedulesFile(): string {
    return path.join(this.root, 'schedules.json');
  }

  /** All schedules, or one project's; oldest first so the list never reorders
   *  itself under the human between visits. A missing or unparseable file is
   *  an empty list — the ticker must keep running, not crash on a bad byte. */
  async listSchedules(projectId?: string): Promise<Schedule[]> {
    const raw = await readFile(this.schedulesFile, 'utf8').catch(() => null);
    let all: Schedule[] = [];
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) all = parsed as Schedule[];
      } catch {
        all = [];
      }
    }
    const wanted = projectId ? all.filter((s) => s.projectId === projectId) : all;
    return [...wanted].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Atomically rewrites schedules.json through `mutate`; returns its result. */
  private mutateSchedules<T>(
    mutate: (schedules: Schedule[]) => { schedules: Schedule[]; result: T },
  ): Promise<T> {
    const task = this.projectsChain.then(async () => {
      const { schedules, result } = mutate(await this.listSchedules());
      await mkdir(this.root, { recursive: true });
      const tmp = path.join(this.root, `.schedules.${crypto.randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, JSON.stringify(schedules, null, 2));
      await rename(tmp, this.schedulesFile);
      return result;
    });
    this.projectsChain = task.catch(() => {});
    return task;
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    return (await this.listSchedules()).find((s) => s.id === id) ?? null;
  }

  /** Records a new schedule. The id and creation time are the store's to give,
   *  like a project's; callers may pass them when restoring a known record. */
  addSchedule(
    s: Omit<Schedule, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
  ): Promise<Schedule> {
    return this.mutateSchedules((schedules) => {
      const schedule: Schedule = {
        ...s,
        id: s.id ?? `s-${crypto.randomBytes(6).toString('hex')}`,
        createdAt: s.createdAt ?? Date.now(),
      };
      return { schedules: [...schedules, schedule], result: schedule };
    });
  }

  /**
   * Merges a partial change. `undefined` means "leave it alone" and `null` is
   * a value in its own right — `pausedReason` and `nextRunAt` are both cleared
   * by writing null, and a spread alone would let an absent key erase them.
   * Identity (id, project, creation) is not patchable; a schedule that moved
   * project would silently start running missions in another folder.
   */
  updateSchedule(
    id: string,
    patch: Partial<Omit<Schedule, 'id' | 'projectId' | 'createdAt'>>,
  ): Promise<Schedule | null> {
    return this.mutateSchedules((schedules) => {
      const i = schedules.findIndex((s) => s.id === id);
      if (i === -1) return { schedules, result: null };
      const next: Schedule = { ...schedules[i] };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        (next as unknown as Record<string, unknown>)[key] = value;
      }
      const updated = [...schedules];
      updated[i] = next;
      return { schedules: updated, result: next };
    });
  }

  /** Forgets one schedule. Returns whether it existed. */
  removeSchedule(id: string): Promise<boolean> {
    return this.mutateSchedules((schedules) => {
      const rest = schedules.filter((s) => s.id !== id);
      return { schedules: rest, result: rest.length !== schedules.length };
    });
  }

  /** Forgets a project's schedules; returns how many went. Called when a
   *  project is unlinked, so no schedule outlives the project it fires in. */
  removeProjectSchedules(projectId: string): Promise<number> {
    return this.mutateSchedules((schedules) => {
      const rest = schedules.filter((s) => s.projectId !== projectId);
      return { schedules: rest, result: schedules.length - rest.length };
    });
  }

  // -- runs -----------------------------------------------------------------

  private runDir(runId: string): string {
    if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id: ${runId}`);
    return path.join(this.runsDir, runId);
  }

  /** The run's own directory, for the record a run keeps beside its meta and log (see snapshot.ts). */
  runDirectory(runId: string): string {
    return this.runDir(runId);
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

  // -- chats ----------------------------------------------------------------

  /**
   * A project's planning conversation lives in the same two-file shape as a
   * run: durable meta plus an append-only event log the UI replays. Project
   * ids are generated by this store (`p-<hex>`), but they arrive here from
   * request paths, so the same containment check a run id gets applies.
   */
  private chatDir(projectId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error(`invalid project id: ${projectId}`);
    return path.join(this.chatsDir, projectId);
  }

  async readChatMeta(projectId: string): Promise<ChatMeta | null> {
    const raw = await readFile(path.join(this.chatDir(projectId), 'meta.json'), 'utf8')
      .catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ChatMeta;
    } catch {
      return null;
    }
  }

  /** Atomically replaces a chat's meta.json, creating the directory if needed. */
  async writeChatMeta(meta: ChatMeta): Promise<void> {
    const dir = this.chatDir(meta.projectId);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.meta.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, path.join(dir, 'meta.json'));
  }

  /** Appends one event to a project's chat log, serialized like a run's. */
  appendChat(projectId: string, event: ForemanEvent): Promise<void> {
    const key = `chat:${projectId}`;
    const file = path.join(this.chatDir(projectId), 'events.jsonl');
    const prev = this.appendChains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => mkdir(this.chatDir(projectId), { recursive: true }))
      .then(() => appendFile(file, JSON.stringify(event) + '\n'));
    this.appendChains.set(key, next.catch(() => {}));
    return next;
  }

  /**
   * Every project id that has a planning conversation on disk. Names that
   * start with an underscore are Foreman's own conversations (the fleet
   * planner's), stored in the same shape but belonging to no project.
   */
  async listChatIds(): Promise<string[]> {
    const names = await readdir(this.chatsDir).catch(() => [] as string[]);
    return names.filter((n) => !n.startsWith('.') && !n.startsWith('_'));
  }

  /** Reads a chat's full event log; skips lines that fail to parse. */
  async readChatEvents(projectId: string): Promise<ForemanEvent[]> {
    const raw = await readFile(path.join(this.chatDir(projectId), 'events.jsonl'), 'utf8')
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

  /**
   * Forgets a conversation: the log and the session id both go, so the next
   * message starts a genuinely new session rather than resuming a cleared one.
   */
  async clearChat(projectId: string): Promise<void> {
    await rm(this.chatDir(projectId), { recursive: true, force: true });
  }

  /**
   * Retires a conversation that produced a mission: the log moves under
   * `chats/_archive/<project>-<run>/`, where `listChatIds` does not look, and
   * the project starts its next visit with a blank page. Kept rather than
   * deleted because it is the story of how that mission came to exist; the
   * run itself is the continuation, and "Plan the next step" forks from it.
   */
  async archiveChat(projectId: string, runId: string): Promise<void> {
    const from = this.chatDir(projectId);
    if (!(await stat(from).catch(() => null))) return;
    const archive = path.join(this.chatsDir, '_archive');
    await mkdir(archive, { recursive: true });
    await rename(from, path.join(archive, `${projectId}-${runId.replace(/[^A-Za-z0-9_-]/g, '')}`));
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
      // Another Foreman may be driving this run right now — the installed
      // service while a dev server starts on the same data directory. Its
      // record is not ours to close; only a run whose owner is gone is orphaned.
      if (meta.ownerPid && meta.ownerPid !== process.pid && processAlive(meta.ownerPid)) continue;
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
