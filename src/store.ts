/**
 * RunStore — durable, append-only persistence for Foreman runs.
 *
 * Layout (default root: ~/.foreman):
 *
 *   <root>/runs/<runId>/meta.json     — RunMeta, rewritten atomically on change
 *   <root>/runs/<runId>/events.jsonl  — one ForemanEvent per line, append-only
 *   <root>/chats/<projectId>/…        — same two files for a project's
 *                                       planning conversation
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
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ChatMeta, ForemanEvent, Project, ProviderRef, RunMeta, RunSummary, SettingsFile,
} from './types.js';

const RUN_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

/** Sortable, collision-safe run id: `<ms since epoch>-<random hex>`. */
export function newRunId(now = Date.now()): string {
  return `${String(now).padStart(13, '0')}-${crypto.randomBytes(4).toString('hex')}`;
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
  removeProject(projectId: string): Promise<boolean> {
    return this.mutateProjects((projects) => {
      const rest = projects.filter((p) => p.id !== projectId);
      return { projects: rest, result: rest.length !== projects.length };
    });
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

  // -- runs -----------------------------------------------------------------

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
