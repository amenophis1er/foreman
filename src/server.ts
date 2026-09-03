// Foreman phase-1 spike: one SDK worker in a chosen folder, transcript streamed
// to a minimal UI over SSE, canUseTool routed to approve/deny cards.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  query,
  type Query,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

const PORT = Number(process.env.PORT ?? 4177);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Read-only, reversible tools are auto-allowed; everything else goes to a card.
const AUTO_ALLOW = new Set([
  'Read', 'Glob', 'Grep', 'TodoWrite', 'Task',
  'WebFetch', 'WebSearch', 'NotebookRead', 'ListMcpResources',
]);

type RunState = {
  q: Query;
  folder: string;
  mission: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  sessionId?: string;
  costUsd?: number;
};

let run: RunState | null = null;
const sseClients = new Set<http.ServerResponse>();
const pendingPermissions = new Map<string, (r: PermissionResult) => void>();

function broadcast(event: string, data: unknown) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

async function startRun(folder: string, mission: string) {
  const q = query({
    prompt: mission,
    options: {
      cwd: folder,
      permissionMode: 'default',
      canUseTool: async (toolName, input, opts) => {
        if (AUTO_ALLOW.has(toolName)) {
          broadcast('auto_allowed', { toolName });
          return { behavior: 'allow' as const };
        }
        const id = opts.toolUseID ?? opts.requestId;
        broadcast('permission_request', {
          id,
          toolName,
          input,
          title: opts.title,
          description: opts.description,
          decisionReason: opts.decisionReason,
        });
        return new Promise<PermissionResult>((resolve) => {
          pendingPermissions.set(id, resolve);
          opts.signal.addEventListener('abort', () => {
            if (pendingPermissions.delete(id)) {
              broadcast('permission_resolved', { id, behavior: 'aborted' });
              resolve({ behavior: 'deny', message: 'Run was interrupted.' });
            }
          });
        });
      },
    },
  });

  run = { q, folder, mission, status: 'running' };
  broadcast('run_started', { folder, mission });

  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const m = msg as Record<string, any>;
      if (m.session_id && run) run.sessionId = m.session_id;
      if (m.type === 'result' && run) {
        run.costUsd = m.total_cost_usd;
        run.status = m.is_error ? 'error' : 'done';
      }
      broadcast('message', msg);
    }
  } catch (err) {
    if (run) run.status = 'error';
    broadcast('run_error', { error: String(err) });
  } finally {
    if (run && run.status === 'running') run.status = 'interrupted';
    broadcast('run_finished', {
      status: run?.status,
      sessionId: run?.sessionId,
      costUsd: run?.costUsd,
    });
  }
}

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
      const { folder, mission } = await readBody(req);
      if (!folder || !mission) return json(res, 400, { error: 'folder and mission are required' });
      const st = await stat(folder).catch(() => null);
      if (!st?.isDirectory()) return json(res, 400, { error: `not a directory: ${folder}` });
      void startRun(folder, mission);
      json(res, 200, { ok: true });
    } else if (req.method === 'POST' && url.pathname === '/permission') {
      const { id, behavior, message } = await readBody(req);
      const resolve = pendingPermissions.get(id);
      if (!resolve) return json(res, 404, { error: 'no pending permission with that id' });
      pendingPermissions.delete(id);
      resolve(
        behavior === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: message || 'Denied by user.' },
      );
      broadcast('permission_resolved', { id, behavior });
      json(res, 200, { ok: true });
    } else if (req.method === 'POST' && url.pathname === '/interrupt') {
      if (!run || run.status !== 'running') return json(res, 409, { error: 'no active run' });
      await run.q.interrupt();
      json(res, 200, { ok: true });
    } else if (req.method === 'GET' && url.pathname === '/status') {
      json(res, 200, {
        run: run
          ? { folder: run.folder, mission: run.mission, status: run.status,
              sessionId: run.sessionId, costUsd: run.costUsd }
          : null,
        pendingPermissions: [...pendingPermissions.keys()],
      });
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`Foreman spike listening on http://localhost:${PORT}`);
});
