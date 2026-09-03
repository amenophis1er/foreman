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
 *   GET    /                     React app (ui/dist, legacy public/ fallback)
 *   GET    /events               SSE stream (enveloped ForemanEvents)
 *   GET    /projects             Projects + active-run summaries + pending counts
 *   POST   /projects             Link a folder {folder, name?}
 *   DELETE /projects/{id}        Unlink (history kept; active run blocks it)
 *   POST   /run                  Start a mission {projectId, mission, budgetUsd}
 *   POST   /permission           Resolve an approval {id, behavior, message?}
 *   POST   /answer               Answer a director question {id, text}
 *   POST   /interrupt            Interrupt a run {runId}
 *   GET    /runs?projectId=      Persisted run summaries, newest first
 *   GET    /runs/{id}/events     Full event log for replay
 *   GET    /missiondoc?run=      A run's .foreman/MISSION.md
 *   GET    /browse?path=         Directory listing for the folder picker
 */
import http from 'node:http';
import os from 'node:os';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionRun } from './orchestrator.js';
import { RunStore, newRunId } from './store.js';
import type { ForemanEvent, RunMeta } from './types.js';

const PORT = Number(process.env.PORT ?? 4177);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'ui', 'dist');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const store = new RunStore(process.env.FOREMAN_HOME);
/** Active runs, keyed by projectId (at most one per project). */
const activeByProject = new Map<string, MissionRun>();
const sseClients = new Set<http.ServerResponse>();

function activeRuns(): MissionRun[] {
  return [...activeByProject.values()];
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

async function startRun(projectId: string, folder: string, mission: string, budgetUsd: number):
  Promise<void> {
  const meta: RunMeta = {
    id: newRunId(),
    projectId,
    folder, mission, budgetUsd,
    status: 'running', costUsd: 0,
    createdAt: Date.now(), workers: [],
  };
  await store.createRun(meta);
  const run = new MissionRun(meta, makeEmitter(meta.id, projectId), (m) => void store.writeMeta(m));
  activeByProject.set(projectId, run);
  try {
    await run.start();
  } finally {
    // Only clear if this run is still the project's active one.
    if (activeByProject.get(projectId) === run) activeByProject.delete(projectId);
  }
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
  const body = await readFile(distFile).catch(() =>
    pathname === '/' ? readFile(path.join(PUBLIC_DIR, 'index.html')).catch(() => null) : null,
  );
  if (!body) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(rel)] ?? 'application/octet-stream' });
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

    } else if (req.method === 'GET' && url.pathname === '/projects') {
      const projects = await store.listProjects();
      json(res, 200, {
        projects: projects.map((p) => {
          const run = activeByProject.get(p.id);
          return {
            ...p,
            activeRun: run ? { ...run.meta } : null,
            pendingPermissions: run?.pendingPermissionIds.length ?? 0,
            pendingQuestions: run?.pendingQuestionIds.length ?? 0,
          };
        }),
      });

    } else if (req.method === 'POST' && url.pathname === '/projects') {
      const { folder, name } = await readBody(req);
      if (typeof folder !== 'string' || !folder) return json(res, 400, { error: 'folder is required' });
      if (!path.isAbsolute(folder)) return json(res, 400, { error: `folder must be an absolute path: ${folder}` });
      const st = await stat(folder).catch(() => null);
      if (st && !st.isDirectory()) return json(res, 400, { error: `not a directory: ${folder}` });
      if (!st) await mkdir(folder, { recursive: true });
      json(res, 200, { project: await store.addProject(folder, typeof name === 'string' ? name : undefined) });

    } else if (req.method === 'DELETE' && projectMatch) {
      if (activeByProject.has(projectMatch[1])) {
        return json(res, 409, { error: 'project has an active mission' });
      }
      const removed = await store.removeProject(projectMatch[1]);
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown project' });

    } else if (req.method === 'POST' && url.pathname === '/run') {
      const { projectId, mission, budgetUsd } = await readBody(req);
      if (typeof projectId !== 'string' || typeof mission !== 'string' || !mission.trim()) {
        return json(res, 400, { error: 'projectId and mission are required' });
      }
      const project = await store.getProject(projectId);
      if (!project) return json(res, 404, { error: 'unknown project' });
      if (activeByProject.has(projectId)) {
        return json(res, 409, { error: 'this project already has an active mission' });
      }
      await mkdir(project.folder, { recursive: true });
      const budget = Number(budgetUsd) > 0 ? Number(budgetUsd) : project.defaultBudgetUsd;
      void startRun(projectId, project.folder, mission, budget);
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

    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

// Reconcile runs orphaned by a previous process before accepting traffic.
const swept = await store.sweepOrphans();
if (swept.length) console.log(`Marked ${swept.length} orphaned run(s) as interrupted:`, swept.join(', '));

server.listen(PORT, () => {
  console.log(`Foreman listening on http://localhost:${PORT}`);
});
