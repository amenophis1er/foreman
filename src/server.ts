/**
 * Foreman HTTP server — thin wiring between the browser UI, mission
 * orchestrators, and the run store. No business logic lives here.
 *
 * Concurrency model: many projects may each have at most ONE active mission;
 * missions across projects run concurrently. Every live SSE frame is wrapped
 * in an envelope `{runId, projectId, data}` so the UI can route it; persisted
 * event logs keep the bare `{ts, event, data}` shape (the run is implicit in
 * the file's location).
 *
 * Endpoints:
 *   GET    /                     React app (ui/dist; build hint when missing)
 *   GET    /events               SSE stream (enveloped ForemanEvents)
 *   GET    /settings             Persisted UI settings (global + project overlays)
 *   PUT    /settings             Save settings {global, projectId?, project?}
 *   GET    /models               Curated model list for the composer pickers
 *   GET    /projects             Projects + active-run summaries + pending counts + lastRun
 *   POST   /projects             Link a folder {folder, name?}
 *   DELETE /projects/{id}        Unlink (history kept; active run blocks it)
 *   POST   /run                  Start a mission {projectId, mission, budgetUsd,
 *                                directorModel?, workerModel?, browserTools?}
 *   POST   /runs/{id}/resume     Resume an interrupted/failed run
 *   POST   /permission           Resolve an approval {id, behavior, message?}
 *   POST   /answer               Answer a director question {id, text}
 *   POST   /steer                Send an operator note to a running director {runId, text}
 *   POST   /interrupt            Interrupt a run {runId}
 *   GET    /runs?projectId=      Persisted run summaries, newest first
 *   GET    /runs/{id}/events     Full event log for replay
 *   GET    /missiondoc?run=      A run's .foreman/MISSION.md
 *   GET    /browse?path=         Directory listing for the folder picker
 *   POST   /mkdir                Create a subfolder {parent, name}
 *   GET    /locate?name=         Find folders by name under $HOME (drag-drop)
 */
import http from 'node:http';
import os from 'node:os';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionRun } from './orchestrator.js';
import { DEFAULT_TOOL_POLICY } from './policy.js';
import { RunStore, newRunId } from './store.js';
import { preflight, reportPreflight } from './preflight.js';
import { defaultInstance, discoverInstances, effectiveConfigDir, resolveInstance } from './instance.js';
import { dirHasCredentials, detectAuth, hasKeychainCredentials, type AuthMode } from './preflight.js';
import type {
  ClaudeInstanceRef, ForemanEvent, ModelChoice, Project, RunMeta, ToolPolicy,
} from './types.js';

/**
 * Curated model list for the composer pickers (GET /models). `id` is exactly
 * what the SDK receives as `options.model`.
 */
const MODELS = [
  { id: 'fable', label: 'Fable', model: 'claude-fable (frontier)', cost: 4, note: 'Frontier. Long-horizon planning and verification.' },
  { id: 'opus', label: 'Opus', model: 'claude-opus (latest)', cost: 3, note: 'Deep reasoning for hard refactors.' },
  { id: 'sonnet', label: 'Sonnet', model: 'claude-sonnet (latest)', cost: 2, note: 'Balanced. The usual worker.' },
  { id: 'haiku', label: 'Haiku', model: 'claude-haiku (latest)', cost: 1, note: 'Fast and cheap for reads and mechanical edits.' },
];

/**
 * The billing mode one project will actually use. `own-login` means the pinned
 * config dir's stored login pays, so a dir without one is a misconfiguration
 * worth surfacing before a mission starts rather than after it fails.
 */
async function projectBilling(p: Project, serverMode: AuthMode): Promise<AuthMode> {
  const instance = resolveInstance(p.claudeInstance);
  if (instance.billing !== 'own-login') return serverMode;
  return (await dirHasCredentials(effectiveConfigDir(instance))) ? 'subscription' : 'none';
}

/** Trims an optional path field from a request body; '' means "cleared". */
function toPath(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Parses a model choice: a known alias or a full claude-* id; else inherit. */
function modelChoice(v: unknown): ModelChoice {
  if (typeof v !== 'string' || !v) return undefined;
  if (MODELS.some((m) => m.id === v)) return v;
  return /^claude-[a-z0-9.-]{1,60}$/.test(v) ? v : undefined;
}

/** Directory names never descended into by the drag-drop folder locator. */
const LOCATE_SKIP = new Set([
  'node_modules', 'Library', 'Applications', '.Trash', 'Music', 'Movies',
  'Pictures', 'dist', 'build', 'target', 'vendor', '.git',
]);

/**
 * Breadth-first search under $HOME for directories whose basename matches
 * `name` (case-insensitive). Bounded by depth, visit count, and wall clock so
 * a request can never wander the whole disk.
 */
async function locateFolders(name: string): Promise<string[]> {
  const wanted = name.toLowerCase();
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: os.homedir(), depth: 0 }];
  const deadline = Date.now() + 2000;
  let visited = 0;

  while (queue.length && results.length < 15 && visited < 20000 && Date.now() < deadline) {
    const { dir, depth } = queue.shift()!;
    visited++;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || LOCATE_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase() === wanted) results.push(full);
      if (depth < 4) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return results;
}

const PORT = Number(process.env.PORT ?? 4177);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'ui', 'dist');

const store = new RunStore(process.env.FOREMAN_HOME || undefined);

/** Detected once: env is immutable for this process, and /projects polls at 3s. */
const authPromise = detectAuth();
/** Active runs by projectId (at most one per project); `null` marks a
 *  reservation taken synchronously before the run object exists. */
const activeByProject = new Map<string, MissionRun | null>();
const sseClients = new Set<http.ServerResponse>();

function activeRuns(): MissionRun[] {
  // Filter out reservation placeholders (see reserveProject).
  return [...activeByProject.values()].filter((r): r is MissionRun => Boolean(r));
}

/** Broadcasts an enveloped frame to live clients and persists the bare event. */
function makeEmitter(runId: string, projectId: string) {
  return (event: string, data: unknown): void => {
    const evt: ForemanEvent = { ts: Date.now(), event, data };
    const frame =
      `event: ${event}\ndata: ${JSON.stringify({ runId, projectId, data })}\n\n`;
    for (const res of sseClients) res.write(frame);
    void store.append(runId, evt);
  };
}

/**
 * Reserves a project for a new/resumed mission. Synchronous check-and-set:
 * routes call this AFTER their last await and BEFORE any further await, which
 * makes "one active mission per project" race-free on the single JS thread.
 */
function reserveProject(projectId: string): boolean {
  if (activeByProject.has(projectId)) return false;
  activeByProject.set(projectId, null); // reservation placeholder
  return true;
}

/** Runs a mission to completion. The project must already be reserved. */
async function driveRun(
  projectId: string, meta: RunMeta, resume?: { sessionId?: string },
  changes?: { directorChanged: boolean; workerChanged: boolean },
): Promise<void> {
  const emit = makeEmitter(meta.id, projectId);
  const run = new MissionRun(meta, emit, (m) => void store.writeMeta(m));
  activeByProject.set(projectId, run);
  try {
    if (changes?.directorChanged || changes?.workerChanged) {
      const parts = [
        changes.directorChanged ? `director → ${meta.directorModel}` : null,
        changes.workerChanged ? `workers → ${meta.workerModel}` : null,
      ].filter(Boolean).join(', ');
      emit('models_changed', {
        text: `Models updated from Settings before resume: ${parts}.` +
          (changes.directorChanged
            ? ' The director starts a fresh session (a model cannot change mid-session);' +
              ' it recovers state from .foreman/MISSION.md.'
            : ''),
        directorModel: meta.directorModel, workerModel: meta.workerModel,
      });
    }
    await run.start(resume);
  } catch (err) {
    // start() catches mission errors itself; anything reaching here is a
    // Foreman bug or storage failure. Never let it become an unhandled
    // rejection that takes the whole server (and other missions) down.
    console.error(`run ${meta.id} failed outside the mission loop:`, err);
    meta.status = 'error';
    meta.endedAt = Date.now();
    await store.writeMeta(meta).catch(() => {});
  } finally {
    if (activeByProject.get(projectId) === run) activeByProject.delete(projectId);
  }
}

/** Effective run configuration: defaults ← global Settings ← project overlay. */
async function effectiveSettings(projectId: string): Promise<{
  toolPolicy: ToolPolicy; autoAllowReadOnly: boolean;
  directorModel: ModelChoice; workerModel: ModelChoice;
}> {
  const s = await store.readSettings()
    .catch(() => ({ global: {}, projects: {} as Record<string, object> }));
  const g = s.global as Record<string, unknown>;
  const p = (s.projects as Record<string, unknown>)[projectId] as Record<string, unknown> ?? {};
  return {
    toolPolicy: {
      ...DEFAULT_TOOL_POLICY,
      ...(g.toolPolicy as ToolPolicy | undefined),
      ...(p.toolPolicy as ToolPolicy | undefined),
    },
    autoAllowReadOnly:
      (p.autoAllowReadOnly ?? g.autoAllowReadOnly) !== false,
    directorModel: modelChoice(p.directorModel ?? g.directorModel),
    workerModel: modelChoice(p.workerModel ?? g.workerModel),
  };
}

async function startRun(
  projectId: string, folder: string, mission: string, budgetUsd: number,
  directorModel: ModelChoice, workerModel: ModelChoice, browserTools: boolean,
  claudeInstance: ClaudeInstanceRef,
): Promise<void> {
  const settings = await effectiveSettings(projectId);
  const meta: RunMeta = {
    id: newRunId(),
    projectId,
    folder, mission, budgetUsd,
    // An explicit composer choice wins; "Default" inherits from Settings.
    directorModel: directorModel ?? settings.directorModel,
    workerModel: workerModel ?? settings.workerModel,
    browserTools: browserTools || undefined,
    toolPolicy: settings.toolPolicy,
    autoAllowReadOnly: settings.autoAllowReadOnly,
    // Frozen at dispatch: a later change to the project or the server default
    // must not silently move an in-flight or resumed run to another install.
    claudeInstance,
    status: 'running', costUsd: 0,
    createdAt: Date.now(), workers: [],
  };
  try {
    await store.createRun(meta);
  } catch (err) {
    activeByProject.delete(projectId);
    console.error(`failed to create run for project ${projectId}:`, err);
    return;
  }
  await driveRun(projectId, meta);
}

/** Resumes an interrupted run by restoring the director's session. */
async function resumeRun(projectId: string, meta: RunMeta): Promise<void> {
  const sessionId = meta.directorSessionId;
  // Resume re-reads Settings, so changing models or tool policy after a
  // failure takes effect on the retry. A director session cannot switch
  // model mid-session, so a changed director model restarts the session
  // fresh (the mission doc carries the state forward).
  const settings = await effectiveSettings(projectId);
  const directorChanged =
    settings.directorModel !== undefined && settings.directorModel !== meta.directorModel;
  const workerChanged =
    settings.workerModel !== undefined && settings.workerModel !== meta.workerModel;
  if (directorChanged) meta.directorModel = settings.directorModel;
  if (workerChanged) meta.workerModel = settings.workerModel;
  meta.toolPolicy = settings.toolPolicy;
  meta.autoAllowReadOnly = settings.autoAllowReadOnly;
  meta.status = 'running';
  meta.endedAt = undefined;
  meta.resumes = (meta.resumes ?? 0) + 1;
  await store.writeMeta(meta).catch((err) => {
    console.error(`failed to persist resume of ${meta.id}:`, err);
  });
  // Always a resume, even when the model change forces a fresh session.
  await driveRun(projectId, meta, { sessionId: directorChanged ? undefined : sessionId }, {
    directorChanged, workerChanged,
  });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.woff2': 'font/woff2',
};

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const distFile = path.resolve(DIST_DIR, rel);
  if (!distFile.startsWith(DIST_DIR + path.sep) && distFile !== path.join(DIST_DIR, 'index.html')) {
    return false;
  }
  const body = await readFile(distFile).catch(() => null);
  if (!body) {
    if (pathname !== '/') return false;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>Foreman</h1><p>UI bundle missing — run <code>npm run ui:build</code> and reload.</p>');
    return true;
  }
  const type = MIME[path.extname(rel)] ?? 'application/octet-stream';
  // index.html must never be cached — it points at hashed asset names.
  const cache = rel === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  res.end(body);
  return true;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>) : {};
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const runEventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
  const runResumeMatch = url.pathname.match(/^\/runs\/([^/]+)\/resume$/);
  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
      if (!(await serveStatic(url.pathname, res))) json(res, 404, { error: 'not found' });

    } else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));

    } else if (req.method === 'GET' && url.pathname === '/settings') {
      json(res, 200, await store.readSettings());

    } else if (req.method === 'PUT' && url.pathname === '/settings') {
      const { global: g, projectId, project } = await readBody(req);
      const current = await store.readSettings();
      const next = {
        global: typeof g === 'object' && g !== null ? g as Record<string, unknown> : current.global,
        projects: { ...current.projects },
      };
      if (typeof projectId === 'string' && projectId) {
        if (typeof project === 'object' && project !== null && Object.keys(project).length) {
          next.projects[projectId] = project as Record<string, unknown>;
        } else {
          delete next.projects[projectId];
        }
      }
      await store.writeSettings(next);
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && url.pathname === '/models') {
      json(res, 200, { models: MODELS });

    } else if (req.method === 'GET' && url.pathname === '/projects') {
      const [projects, allRuns, auth] = await Promise.all([
        store.listProjects(), store.listRuns(), authPromise,
      ]);
      json(res, 200, {
        // Billing mode travels with every fleet poll so the UI can state it
        // plainly wherever money is about to be spent.
        authMode: auth.mode,
        authSource: auth.source,
        projects: await Promise.all(projects.map(async (p) => {
          const run = activeByProject.get(p.id);
          // Newest finished run for the idle-card summary (runs are newest-first).
          const lastRun = allRuns.find((r) => r.projectId === p.id && r.status !== 'running') ?? null;
          return {
            ...p,
            // What THIS project will actually bill, which can differ from the
            // server's mode when the pin opts out of the inherited key.
            billingMode: await projectBilling(p, auth.mode),
            activeRun: run ? { ...run.meta } : null,
            lastRun: lastRun && {
              mission: lastRun.mission, status: lastRun.status,
              createdAt: lastRun.createdAt, costUsd: lastRun.costUsd,
            },
            pendingPermissions: run?.pendingPermissionIds.length ?? 0,
            pendingQuestions: run?.pendingQuestionIds.length ?? 0,
          };
        })),
      });

    } else if (req.method === 'POST' && url.pathname === '/projects') {
      const { folder, name, claudeConfigDir, claudeExecutable } = await readBody(req);
      if (typeof folder !== 'string' || !folder) return json(res, 400, { error: 'folder is required' });
      if (!path.isAbsolute(folder)) return json(res, 400, { error: `folder must be an absolute path: ${folder}` });
      const st = await stat(folder).catch(() => null);
      if (st && !st.isDirectory()) return json(res, 400, { error: `not a directory: ${folder}` });
      if (!st) await mkdir(folder, { recursive: true });
      const pin =
        typeof claudeConfigDir === 'string' || typeof claudeExecutable === 'string'
          ? {
              ...(typeof claudeConfigDir === 'string' ? { configDir: claudeConfigDir } : {}),
              ...(typeof claudeExecutable === 'string' ? { executable: claudeExecutable } : {}),
            }
          : undefined;
      json(res, 200, {
        project: await store.addProject(folder, typeof name === 'string' ? name : undefined, pin),
      });

    } else if (req.method === 'PATCH' && projectMatch) {
      const { name, defaultBudgetUsd, claudeConfigDir, claudeExecutable, claudeBilling } =
        await readBody(req);
      // null clears the pin; undefined leaves it untouched.
      const pinGiven =
        claudeConfigDir !== undefined || claudeExecutable !== undefined || claudeBilling !== undefined;
      const ownLogin = claudeBilling === 'own-login';
      // A billing choice is itself a pin, so clearing needs all three empty.
      const cleared =
        pinGiven && !toPath(claudeConfigDir) && !toPath(claudeExecutable) && !ownLogin;
      const updated = await store.updateProject(projectMatch[1], {
        name: typeof name === 'string' ? name : undefined,
        defaultBudgetUsd: typeof defaultBudgetUsd === 'number' ? defaultBudgetUsd : undefined,
        claudeInstance: !pinGiven
          ? undefined
          : cleared
            ? null
            : {
                ...(toPath(claudeConfigDir) ? { configDir: toPath(claudeConfigDir)! } : {}),
                ...(toPath(claudeExecutable) ? { executable: toPath(claudeExecutable)! } : {}),
                ...(ownLogin ? { billing: 'own-login' as const } : {}),
              },
      });
      json(res, updated ? 200 : 404, updated ? { project: updated } : { error: 'unknown project' });

    } else if (req.method === 'GET' && url.pathname === '/instances') {
      const [instances, auth, keychain] = await Promise.all([
        discoverInstances(dirHasCredentials),
        detectAuth(),
        hasKeychainCredentials(),
      ]);
      json(res, 200, {
        serverDefault: defaultInstance(),
        // Auth is process-wide: an API key in the environment outranks every
        // stored login, so the picker must not imply the choice is per-dir.
        authMode: auth.mode,
        keychainLogin: keychain,
        instances,
      });

    } else if (req.method === 'DELETE' && projectMatch) {
      if (activeByProject.has(projectMatch[1])) {
        return json(res, 409, { error: 'project has an active mission' });
      }
      const removed = await store.removeProject(projectMatch[1]);
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown project' });

    } else if (req.method === 'POST' && url.pathname === '/run') {
      const { projectId, mission, budgetUsd, directorModel, workerModel, browserTools } = await readBody(req);
      if (typeof projectId !== 'string' || typeof mission !== 'string' || !mission.trim()) {
        return json(res, 400, { error: 'projectId and mission are required' });
      }
      const project = await store.getProject(projectId);
      if (!project) return json(res, 404, { error: 'unknown project' });
      await mkdir(project.folder, { recursive: true });
      // Reservation is the last step before dispatch — no awaits in between.
      if (!reserveProject(projectId)) {
        return json(res, 409, { error: 'this project already has an active mission' });
      }
      const budget = Number(budgetUsd) > 0 ? Number(budgetUsd) : project.defaultBudgetUsd;
      void startRun(projectId, project.folder, mission, budget,
        modelChoice(directorModel), modelChoice(workerModel), browserTools === true,
        resolveInstance(project.claudeInstance));
      json(res, 200, { ok: true });

    } else if (req.method === 'POST' && url.pathname === '/permission') {
      const { id, behavior, message } = await readBody(req);
      const valid = behavior === 'allow' || behavior === 'allow_always' || behavior === 'deny';
      if (typeof id !== 'string' || !valid) return json(res, 400, { error: 'invalid request' });
      // Approval ids are globally unique (tool-use ids); find the owning run.
      const ok = activeRuns().some((r) =>
        r.resolvePermission(id, behavior, message as string | undefined));
      if (!ok) return json(res, 404, { error: 'no pending permission with that id' });
      json(res, 200, { ok: true });

    } else if (req.method === 'POST' && url.pathname === '/answer') {
      const { id, text } = await readBody(req);
      if (typeof id !== 'string') return json(res, 400, { error: 'invalid request' });
      const ok = activeRuns().some((r) => r.answerQuestion(id, String(text ?? '')));
      if (!ok) return json(res, 404, { error: 'no pending question with that id' });
      json(res, 200, { ok: true });

    } else if (req.method === 'POST' && url.pathname === '/steer') {
      const { runId, text } = await readBody(req);
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (typeof runId !== 'string' || !trimmed) return json(res, 400, { error: 'invalid request' });
      const run = activeRuns().find((r) => r.meta.id === runId);
      if (!run) return json(res, 404, { error: 'no active run with that id' });
      if (!run.steer(trimmed)) return json(res, 409, { error: 'run is no longer accepting steers' });
      json(res, 200, { ok: true });

    } else if (req.method === 'POST' && url.pathname === '/interrupt') {
      const { runId } = await readBody(req);
      const run = activeRuns().find((r) => r.meta.id === runId);
      if (!run) return json(res, 404, { error: 'no active run with that id' });
      await run.interrupt();
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && url.pathname === '/runs') {
      const projectId = url.searchParams.get('projectId');
      const runs = await store.listRuns();
      json(res, 200, { runs: projectId ? runs.filter((r) => r.projectId === projectId) : runs });

    } else if (req.method === 'POST' && runResumeMatch) {
      const meta = await store.readMeta(runResumeMatch[1]).catch(() => null);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      if (meta.status === 'running' || meta.status === 'done') {
        return json(res, 409, { error: `run is ${meta.status}; only interrupted or failed runs can resume` });
      }
      if (!meta.directorSessionId) {
        return json(res, 409, { error: 'run has no director session to resume' });
      }
      if (!meta.projectId || !(await store.getProject(meta.projectId))) {
        return json(res, 409, { error: 'run has no linked project' });
      }
      // Reservation is the last step before dispatch — no awaits in between.
      if (!reserveProject(meta.projectId)) {
        return json(res, 409, { error: 'this project already has an active mission' });
      }
      void resumeRun(meta.projectId, meta);
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && runEventsMatch) {
      const events = await store.readEvents(runEventsMatch[1]).catch(() => null);
      if (!events) return json(res, 404, { error: 'unknown run' });
      json(res, 200, { events });

    } else if (req.method === 'GET' && url.pathname === '/missiondoc') {
      const runId = url.searchParams.get('run');
      if (!runId) return json(res, 400, { error: 'run parameter is required' });
      const meta = await store.readMeta(runId);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      const doc = await readFile(path.join(meta.folder, '.foreman', 'MISSION.md'), 'utf8')
        .catch(() => null);
      json(res, 200, { doc });

    } else if (req.method === 'GET' && url.pathname === '/browse') {
      const requested = url.searchParams.get('path') || os.homedir();
      const dir = path.resolve(requested);
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) return json(res, 400, { error: `not a directory: ${dir}` });
      const entries = await readdir(dir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      const parent = path.dirname(dir);
      json(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs });

    } else if (req.method === 'POST' && url.pathname === '/mkdir') {
      const { parent, name } = await readBody(req);
      if (typeof parent !== 'string' || !path.isAbsolute(parent)) {
        return json(res, 400, { error: 'parent must be an absolute path' });
      }
      if (typeof name !== 'string' || !name.trim() || /[/\\]/.test(name) || name.trim().startsWith('.')) {
        return json(res, 400, { error: 'invalid folder name' });
      }
      const parentSt = await stat(parent).catch(() => null);
      if (!parentSt?.isDirectory()) return json(res, 400, { error: `not a directory: ${parent}` });
      const created = path.join(parent, name.trim());
      await mkdir(created, { recursive: true });
      json(res, 200, { path: created });

    } else if (req.method === 'GET' && url.pathname === '/locate') {
      const name = (url.searchParams.get('name') ?? '').trim();
      if (!name) return json(res, 400, { error: 'name is required' });
      json(res, 200, { matches: await locateFolders(name) });

    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

// Fail loudly on a misconfigured install before anything else happens.
if (!reportPreflight(await preflight({ port: PORT, foremanHome: store.root, distDir: DIST_DIR }))) {
  process.exit(1);
}

// Reconcile runs orphaned by a previous process before accepting traffic.
const swept = await store.sweepOrphans();
if (swept.length) console.log(`Marked ${swept.length} orphaned run(s) as interrupted:`, swept.join(', '));

server.listen(PORT, () => {
  console.log(`Foreman listening on http://localhost:${PORT}`);
});
