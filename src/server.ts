// Foreman phase-2: a director agent plans the mission into .foreman/MISSION.md,
// delegates implementation to worker sessions via in-process MCP tools, and
// verifies DONE independently. Worker calls block inside the director's tool
// call, so results land in the director's context as ordinary tool results.
import http from 'node:http';
import os from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  query,
  tool,
  createSdkMcpServer,
  type Query,
  type PermissionResult,
  type SDKMessage,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk';

const PORT = Number(process.env.PORT ?? 4177);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Read-only, reversible tools are auto-allowed; everything else goes to a card.
const AUTO_ALLOW = new Set([
  'Read', 'Glob', 'Grep', 'TodoWrite', 'Task',
  'WebFetch', 'WebSearch', 'NotebookRead', 'ListMcpResources',
]);

const DIRECTOR_CHARTER = `
You are the FOREMAN DIRECTOR. You run a mission autonomously inside one folder by
directing worker agents. Non-negotiable rules, in priority order:

1. PLAN FIRST. Before anything else, write .foreman/MISSION.md in the working
   directory with: the mission (one line), DONE WHEN (verifiable criteria), a
   plan as a checklist of verifiable milestones, a Log section, and a Decisions
   section. Update it after every milestone — it is the mission's source of
   truth, not your context window.
2. DELEGATE IMPLEMENTATION. Use mcp__foreman__spawn_worker to have a worker do
   the building/editing. Give each worker one well-scoped, self-contained task
   with full context (paths, constraints, expected result). Use
   mcp__foreman__message_worker to send follow-ups or corrections to an
   existing worker. You may read files and run verification commands yourself,
   but implementation edits belong to workers.
3. VERIFY INDEPENDENTLY. Never trust a worker's "done". Read the files and run
   the checks yourself before ticking a milestone.
4. ESCALATE, DON'T POWER THROUGH. Anything irreversible, out of scope, or
   surprising: ask the human via mcp__foreman__ask_human and wait for the answer.
5. NEVER modify Foreman itself, its server, or any oversight tooling. Tooling
   failure is an escalation, never a self-repair.
6. When DONE WHEN is verified, update MISSION.md (all boxes ticked, final log
   entry) and end with a short summary of what was built and how you verified it.
`;

const WORKER_CHARTER = `
You are a FOREMAN WORKER. Complete exactly the task you were given, inside the
working directory. Never ask interactive questions — if you are blocked on a
decision you cannot make, print "BLOCKED: <your question>" and end your turn.
When finished, end with a concise report of what you did and how you checked it.
`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type WorkerInfo = {
  id: string;
  q?: Query;
  sessionId?: string;
  status: 'running' | 'done' | 'error';
  costUsd: number;
  task: string;
};

type RunState = {
  folder: string;
  mission: string;
  budgetUsd: number;
  status: 'running' | 'done' | 'error' | 'interrupted';
  costUsd: number;
  directorQ?: Query;
  directorSessionId?: string;
  workers: Map<string, WorkerInfo>;
  workerSeq: number;
};

let run: RunState | null = null;
const sseClients = new Set<http.ServerResponse>();

type PendingPermission = {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  suggestions?: unknown[];
};
const pendingPermissions = new Map<string, PendingPermission>();
const pendingQuestions = new Map<string, (answer: string) => void>();
let runAutoAllow = new Set<string>();

function broadcast(event: string, data: unknown) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

function addCost(usd: number | undefined) {
  if (run && typeof usd === 'number') {
    run.costUsd += usd;
    broadcast('cost', { costUsd: run.costUsd, budgetUsd: run.budgetUsd });
  }
}

// ---------------------------------------------------------------------------
// Permission policy (shared by director and workers)
// ---------------------------------------------------------------------------

function makePolicy(agent: string, folder: string): CanUseTool {
  const foremanDir = path.join(folder, '.foreman') + path.sep;
  return async (toolName, input, opts) => {
    const routine = !opts.matchedAskRule && !opts.decisionReason;
    const isMissionDocWrite =
      (toolName === 'Write' || toolName === 'Edit') &&
      typeof input.file_path === 'string' &&
      (input.file_path.startsWith(foremanDir) || input.file_path === foremanDir.slice(0, -1));
    if (
      toolName.startsWith('mcp__foreman__') ||
      AUTO_ALLOW.has(toolName) ||
      isMissionDocWrite ||
      (runAutoAllow.has(toolName) && routine)
    ) {
      broadcast('auto_allowed', { agent, toolName });
      return { behavior: 'allow' as const };
    }
    const id = opts.toolUseID ?? opts.requestId;
    broadcast('permission_request', {
      id, agent, toolName, input,
      title: opts.title,
      description: opts.description,
      decisionReason: opts.decisionReason,
    });
    return new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(id, { resolve, toolName, suggestions: opts.suggestions });
      opts.signal.addEventListener('abort', () => {
        if (pendingPermissions.delete(id)) {
          broadcast('permission_resolved', { id, behavior: 'aborted' });
          resolve({ behavior: 'deny', message: 'Run was interrupted.' });
        }
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

async function runWorker(
  r: RunState,
  workerId: string,
  prompt: string,
  resumeSessionId?: string,
): Promise<{ report: string; isError: boolean }> {
  const w: WorkerInfo = r.workers.get(workerId) ?? {
    id: workerId, status: 'running', costUsd: 0, task: prompt,
  };
  w.status = 'running';
  r.workers.set(workerId, w);
  broadcast('worker_started', { id: workerId, task: prompt.slice(0, 200), resumed: !!resumeSessionId });

  const q = query({
    prompt,
    options: {
      cwd: r.folder,
      permissionMode: 'default',
      resume: resumeSessionId,
      maxTurns: 60,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: WORKER_CHARTER },
      canUseTool: makePolicy(workerId, r.folder),
    },
  });
  w.q = q;

  let report = '';
  let isError = false;
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const m = msg as Record<string, any>;
      if (m.session_id) w.sessionId = m.session_id;
      if (m.type === 'result') {
        report = m.result ?? '';
        isError = !!m.is_error;
        addCost(m.total_cost_usd);
        w.costUsd += m.total_cost_usd ?? 0;
      }
      broadcast('message', { agent: workerId, msg });
    }
  } catch (err) {
    isError = true;
    report = report || `Worker crashed: ${String(err)}`;
  } finally {
    w.q = undefined;
    w.status = isError ? 'error' : 'done';
    broadcast('worker_finished', { id: workerId, status: w.status, sessionId: w.sessionId });
  }
  return { report, isError };
}

// ---------------------------------------------------------------------------
// Director MCP tools
// ---------------------------------------------------------------------------

function makeForemanTools(r: RunState) {
  const overBudget = () =>
    r.costUsd >= r.budgetUsd
      ? `BUDGET EXHAUSTED: $${r.costUsd.toFixed(2)} spent of $${r.budgetUsd.toFixed(2)} cap. ` +
        `Do not start new work. Update MISSION.md, summarize the state, and stop ` +
        `(or ask the human for a budget increase via ask_human).`
      : null;

  const spawnWorker = tool(
    'spawn_worker',
    'Spawn a worker agent to execute one self-contained implementation task in the ' +
    'working directory. Blocks until the worker finishes and returns its final report. ' +
    'Include all context the worker needs: it does not see your conversation.',
    { task: z.string().describe('Full task description with context, paths, and the expected result') },
    async ({ task }) => {
      const stop = overBudget();
      if (stop) return { content: [{ type: 'text' as const, text: stop }] };
      const id = `worker-${++r.workerSeq}`;
      const { report, isError } = await runWorker(r, id, task);
      return {
        content: [{
          type: 'text' as const,
          text: `[${id}${isError ? ' FAILED' : ' finished'}] ${report || '(no report)'}`,
        }],
      };
    },
  );

  const messageWorker = tool(
    'message_worker',
    'Send a follow-up message to an existing worker (correction, next step, answer to a ' +
    'BLOCKED question). Resumes that worker\'s session with its prior context intact. ' +
    'Blocks until the worker finishes and returns its report.',
    {
      worker_id: z.string().describe('The worker id, e.g. "worker-1"'),
      message: z.string().describe('The follow-up instruction or answer'),
    },
    async ({ worker_id, message }) => {
      const stop = overBudget();
      if (stop) return { content: [{ type: 'text' as const, text: stop }] };
      const w = r.workers.get(worker_id);
      if (!w?.sessionId) {
        return { content: [{ type: 'text' as const, text: `No resumable worker "${worker_id}".` }] };
      }
      const { report, isError } = await runWorker(r, worker_id, message, w.sessionId);
      return {
        content: [{
          type: 'text' as const,
          text: `[${worker_id}${isError ? ' FAILED' : ' finished'}] ${report || '(no report)'}`,
        }],
      };
    },
  );

  const askHuman = tool(
    'ask_human',
    'Ask the human overseer a question and wait for their answer. Use for anything ' +
    'irreversible, out of scope, over budget, or that only a human can decide.',
    { question: z.string().describe('The question, with enough context to answer it') },
    async ({ question }) => {
      const id = `q-${Date.now()}`;
      broadcast('question', { id, question });
      const answer = await new Promise<string>((resolve) => pendingQuestions.set(id, resolve));
      broadcast('question_answered', { id });
      return { content: [{ type: 'text' as const, text: `Human answered: ${answer}` }] };
    },
  );

  return createSdkMcpServer({ name: 'foreman', tools: [spawnWorker, messageWorker, askHuman] });
}

// ---------------------------------------------------------------------------
// Mission run
// ---------------------------------------------------------------------------

async function startRun(folder: string, mission: string, budgetUsd: number) {
  runAutoAllow = new Set();
  const r: RunState = {
    folder, mission, budgetUsd,
    status: 'running', costUsd: 0,
    workers: new Map(), workerSeq: 0,
  };
  run = r;
  broadcast('run_started', { folder, mission, budgetUsd });

  const q = query({
    prompt:
      `MISSION: ${mission}\n\nBudget: $${budgetUsd.toFixed(2)} total for this run. ` +
      `Working directory: ${folder}. Begin by writing .foreman/MISSION.md, then execute the plan.`,
    options: {
      cwd: folder,
      permissionMode: 'default',
      maxTurns: 150,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: DIRECTOR_CHARTER },
      mcpServers: { foreman: makeForemanTools(r) },
      canUseTool: makePolicy('director', folder),
    },
  });
  r.directorQ = q;

  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const m = msg as Record<string, any>;
      if (m.session_id) r.directorSessionId = m.session_id;
      if (m.type === 'result') {
        addCost(m.total_cost_usd);
        r.status = m.is_error ? 'error' : 'done';
      }
      broadcast('message', { agent: 'director', msg });
    }
  } catch (err) {
    r.status = 'error';
    broadcast('run_error', { error: String(err) });
  } finally {
    if (r.status === 'running') r.status = 'interrupted';
    broadcast('run_finished', {
      status: r.status,
      costUsd: r.costUsd,
      directorSessionId: r.directorSessionId,
    });
  }
}

async function interruptRun() {
  if (!run) return;
  for (const w of run.workers.values()) {
    if (w.q) await w.q.interrupt().catch(() => {});
  }
  await run.directorQ?.interrupt().catch(() => {});
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    } else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    } else if (req.method === 'POST' && url.pathname === '/run') {
      if (run?.status === 'running') return json(res, 409, { error: 'a run is already active' });
      const { folder, mission, budgetUsd } = await readBody(req);
      if (!folder || !mission) return json(res, 400, { error: 'folder and mission are required' });
      const st = await stat(folder).catch(() => null);
      if (!st?.isDirectory()) return json(res, 400, { error: `not a directory: ${folder}` });
      void startRun(folder, mission, Number(budgetUsd) > 0 ? Number(budgetUsd) : 5);
      json(res, 200, { ok: true });
    } else if (req.method === 'POST' && url.pathname === '/permission') {
      const { id, behavior, message } = await readBody(req);
      const pending = pendingPermissions.get(id);
      if (!pending) return json(res, 404, { error: 'no pending permission with that id' });
      pendingPermissions.delete(id);
      if (behavior === 'allow_always') {
        runAutoAllow.add(pending.toolName);
        pending.resolve({ behavior: 'allow', updatedPermissions: pending.suggestions as any });
      } else if (behavior === 'allow') {
        pending.resolve({ behavior: 'allow' });
      } else {
        pending.resolve({ behavior: 'deny', message: message || 'Denied by user.' });
      }
      broadcast('permission_resolved', { id, behavior });
      json(res, 200, { ok: true });
    } else if (req.method === 'POST' && url.pathname === '/answer') {
      const { id, text } = await readBody(req);
      const resolve = pendingQuestions.get(id);
      if (!resolve) return json(res, 404, { error: 'no pending question with that id' });
      pendingQuestions.delete(id);
      resolve(String(text ?? ''));
      json(res, 200, { ok: true });
    } else if (req.method === 'POST' && url.pathname === '/interrupt') {
      if (!run || run.status !== 'running') return json(res, 409, { error: 'no active run' });
      await interruptRun();
      json(res, 200, { ok: true });
    } else if (req.method === 'GET' && url.pathname === '/missiondoc') {
      if (!run) return json(res, 404, { error: 'no run' });
      const doc = await readFile(path.join(run.folder, '.foreman', 'MISSION.md'), 'utf8')
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
    } else if (req.method === 'GET' && url.pathname === '/status') {
      json(res, 200, {
        run: run
          ? {
              folder: run.folder, mission: run.mission, status: run.status,
              costUsd: run.costUsd, budgetUsd: run.budgetUsd,
              directorSessionId: run.directorSessionId,
              workers: [...run.workers.values()].map(({ q, ...w }) => w),
            }
          : null,
        pendingPermissions: [...pendingPermissions.keys()],
        pendingQuestions: [...pendingQuestions.keys()],
      });
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Foreman listening on http://localhost:${PORT}`);
});
