/**
 * `foreman mcp` — Foreman for other agents.
 *
 * A stdio MCP server another agent starts on demand (Claude Code, Codex,
 * Antigravity: `<client> mcp add foreman -- foreman mcp`). Deliberately thin:
 * every tool is a call to the running Foreman server over the same REST and
 * event stream the dashboard uses, so policy lives in one place — the server
 * — and this file has no business logic of its own.
 *
 * What it offers is what an agent watching or launching missions needs: the
 * fleet, runs, a run's status with a `wait` (one call that returns when
 * something changes, instead of a polling loop), the transcript, the mission
 * doc and memory, linking a project, starting a mission, steering a director.
 *
 * What it does not offer, on purpose: approving or denying, answering the
 * director's questions, interrupt, resume, raising a budget, opening a pull
 * request, settings and keys. Those are the moments Foreman exists to put a
 * human in; `run_status` says when a run needs one, and with what, so the
 * agent's job is to send the human to decide, not to decide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export interface ToolResult {
  /** What the model reads. */
  text: string;
  /** The same facts, structured. */
  data?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ForemanClientOptions {
  /** Where Foreman answers; `FOREMAN_URL` or http://127.0.0.1:4177. */
  base: string;
  fetchImpl?: typeof fetch;
  /** Longest a `wait` may block, in seconds. */
  maxWaitSeconds?: number;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** A folder that is Foreman itself: never a mission target (the oversight rule). */
export function isForemanCheckout(folder: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { bin?: Record<string, string> | string };
    if (pkg.bin && typeof pkg.bin === 'object' && 'foreman' in pkg.bin) return true;
  } catch { /* no package.json, or not ours */ }
  return fs.existsSync(path.join(folder, 'src', 'orchestrator.ts')) && fs.existsSync(path.join(folder, 'src', 'policy.ts'));
}

interface RunSummary {
  id: string; projectId?: string; mission: string; title?: string; status: string;
  costUsd: number; budgetUsd: number; costBasis?: string; createdAt: number; endedAt?: number;
  directorModel?: string; workerModel?: string; resumes?: number; stopReason?: string;
  workers?: Array<{ id: string; status: string; costUsd: number; task: string }>;
  git?: { branch: string; base: string; commits?: number; pr?: string; prState?: string };
  usage?: { inputTokens: number; outputTokens: number };
}
interface Need { kind: string; id: string; runId?: string; text: string; options?: string[]; toolName?: string; since?: number }
interface ProjectCard {
  id: string; name: string; folder: string; activeRun: RunSummary | null;
  lastRun: { id: string; title?: string; mission: string; status: string; costUsd: number; createdAt: number } | null;
  pendingPermissions: number; pendingQuestions: number; needs?: Need[]; git?: { branch?: string; dirty?: boolean } | null;
}

/** One line for a run, the way the fleet board says it. */
function runLine(r: RunSummary): string {
  const cost = r.costBasis && r.costBasis !== 'priced' ? `${r.costBasis}` : `${usd(r.costUsd)} of ${usd(r.budgetUsd)}`;
  return `${r.id} · ${r.status}${r.stopReason ? ` (stopped at its ${r.stopReason} cap)` : ''} · ${cost} · ${r.title || r.mission.slice(0, 80)}`;
}

/** A transcript event as one line; null for noise. */
export function eventLine(event: string, d: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (event) {
    case 'run_started': return 'run started';
    case 'run_resumed': return 'run resumed';
    case 'run_finished': return `run finished: ${s('status')}`;
    case 'worker_started': return `${s('id')} started: ${s('task').slice(0, 120)}`;
    case 'worker_finished': return `${s('id')} finished: ${s('status')}`;
    case 'worker_progress': return `${s('id')}: ${d.blocked ? `BLOCKED — ${String(d.blocked)}` : s('status')}`;
    case 'permission_request': return `NEEDS YOU — ${s('agent')} wants ${s('toolName')}${s('decisionReason') ? ` (${s('decisionReason')})` : ''}`;
    case 'permission_resolved': return `approval ${s('behavior')}`;
    case 'permission_timeout': return 'approval timed out (unattended default applied)';
    case 'question': return `NEEDS YOU — director asks: ${s('question')}`;
    case 'question_answered': return 'question answered';
    case 'budget_alert': case 'budget_stop': case 'models_changed': case 'settings_changed': case 'mission_incomplete':
      return s('text') || s('reason') || (Array.isArray(d.changes) ? (d.changes as string[]).join('; ') : null) || event;
    case 'git_branch': return `on branch ${s('branch')}`;
    case 'git_committed': return s('text') || 'branch closed';
    case 'pull_request': return s('url') ? `pull request: ${s('url')}` : null;
    case 'memory_updated': return 'project memory rewritten';
    case 'steer': return `operator → ${s('to')}: ${s('text')}`;
    case 'message': {
      const msg = d.msg as { type?: string; message?: { content?: Array<{ type: string; text?: string; name?: string }> } } | undefined;
      if (msg?.type !== 'assistant') return null;
      const block = msg.message?.content?.find((c) => c.type === 'text' && c.text) ?? msg.message?.content?.find((c) => c.type === 'tool_use');
      if (!block) return null;
      return block.type === 'text' ? `${s('agent')}: ${(block.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}` : `${s('agent')} → ${block.name}`;
    }
    default: return null;
  }
}

/** DONE WHEN lines from a mission doc: ticked and unticked. */
export function doneWhen(doc: string): { done: string[]; open: string[] } {
  const done: string[] = []; const open: string[] = [];
  for (const line of doc.split('\n')) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/.exec(line);
    if (!m) continue;
    (m[1].trim() ? done : open).push(m[2].trim());
  }
  return { done, open };
}

/**
 * Waits for the next event on a run, over the server's own SSE stream. One
 * subscription per call, filtered to the run; resolves true on the first
 * event that names it, false at the timeout. Never polls.
 */
export async function waitForRunEvent(base: string, runId: string, seconds: number, fetchImpl: typeof fetch): Promise<boolean> {
  const ctl = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // The clock wins whatever the stream does: a fetch that ignores the abort
  // signal, or a body that never yields, must not hold the caller past the
  // seconds it asked for.
  const timeout = new Promise<false>((resolve) => setTimeout(() => { ctl.abort(); void reader?.cancel().catch(() => {}); resolve(false); }, Math.max(1, seconds) * 1000));
  const watch = (async (): Promise<boolean> => {
    try {
      const res = await fetchImpl(`${base}/events`, { signal: ctl.signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) return false;
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const env = JSON.parse(line.slice(5).trim()) as { runId?: string | null };
            if (env.runId === runId) { ctl.abort(); void reader.cancel().catch(() => {}); return true; }
          } catch { /* a comment or a partial frame */ }
        }
      }
    } catch {
      return false;
    }
  })();
  return Promise.race([watch, timeout]);
}

/** The tools, as data — the MCP server registers them; the tests call them. */
export function foremanTools(opts: ForemanClientOptions): ToolDef[] {
  const base = opts.base.replace(/\/+$/, '');
  const f = opts.fetchImpl ?? fetch;
  const maxWait = opts.maxWaitSeconds ?? 300;

  async function get<T>(p: string): Promise<T> {
    let res: Response;
    try { res = await f(`${base}${p}`); } catch (err) {
      throw new Error(`Foreman is not answering at ${base} (${err instanceof Error ? err.message : String(err)}). Start it with \`foreman\`, or set FOREMAN_URL.`);
    }
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }
  async function post<T>(p: string, body: unknown): Promise<{ ok: boolean; status: number; json: T }> {
    let res: Response;
    try { res = await f(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch (err) {
      throw new Error(`Foreman is not answering at ${base} (${err instanceof Error ? err.message : String(err)}). Start it with \`foreman\`, or set FOREMAN_URL.`);
    }
    const json = await res.json().catch(() => ({})) as T;
    return { ok: res.ok, status: res.status, json };
  }
  async function findRun(runId: string): Promise<RunSummary> {
    const { runs } = await get<{ runs: RunSummary[] }>('/runs');
    const r = runs.find((x) => x.id === runId);
    if (!r) throw new Error(`No run ${runId}. list_runs shows what exists.`);
    return r;
  }

  const fleet: ToolDef = {
    name: 'fleet_status',
    description: 'Every linked project with what it is doing: the active mission (status, spend against cap, crew), what needs a human, and the last finished run. Start here.',
    schema: {},
    run: async () => {
      const d = await get<{ projects: ProjectCard[]; authMode?: string; version?: string }>('/projects');
      const lines = d.projects.map((p) => {
        const a = p.activeRun;
        const needs = (p.pendingPermissions ?? 0) + (p.pendingQuestions ?? 0);
        const head = `${p.name} (${p.id}) — ${p.folder}${p.git?.branch ? ` · ${p.git.branch}` : ''}`;
        if (a) return `${head}\n  running: ${runLine(a)}${needs ? `\n  NEEDS YOU: ${needs} pending — the human decides these on the dashboard or phone` : ''}`;
        if (p.lastRun) return `${head}\n  idle · last: ${p.lastRun.status} · ${usd(p.lastRun.costUsd)} · ${p.lastRun.title || p.lastRun.mission.slice(0, 80)}`;
        return `${head}\n  idle · no runs yet`;
      });
      return {
        text: lines.length ? lines.join('\n') : 'No projects linked. link_project adds one.',
        data: { version: d.version, authMode: d.authMode, projects: d.projects.map((p) => ({ id: p.id, name: p.name, folder: p.folder, branch: p.git?.branch, activeRun: p.activeRun && { id: p.activeRun.id, status: p.activeRun.status, costUsd: p.activeRun.costUsd, budgetUsd: p.activeRun.budgetUsd }, needs: p.needs ?? [], lastRun: p.lastRun })) },
      };
    },
  };

  const listRuns: ToolDef = {
    name: 'list_runs',
    description: 'Run summaries, newest first, optionally for one project.',
    schema: { projectId: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
    run: async ({ projectId, limit }) => {
      const { runs } = await get<{ runs: RunSummary[] }>(`/runs${projectId ? `?projectId=${encodeURIComponent(String(projectId))}` : ''}`);
      const shown = runs.slice(0, Number(limit ?? 20));
      return { text: shown.length ? shown.map(runLine).join('\n') : 'No runs.', data: { runs: shown } };
    },
  };

  /** What is pending on a run right now, from the fleet payload. */
  async function needsOf(id: string): Promise<Need[]> {
    const projects = (await get<{ projects: ProjectCard[] }>('/projects')).projects;
    const card = projects.find((p) => p.activeRun?.id === id);
    return (card?.needs ?? []).filter((n) => !n.runId || n.runId === id);
  }

  const runStatus: ToolDef = {
    name: 'run_status',
    description: 'One run: status, spend against cap, crew and their states, DONE WHEN ticks, what needs a human, branch and pull request. With wait_seconds > 0 it blocks until `until` is met — "any" change on the run, the run "finished", or it "needs_you" (a pending approval or question, or finished) — or until the timeout. Use it instead of polling; call again if it timed out.',
    schema: {
      runId: z.string(),
      wait_seconds: z.number().int().min(0).max(maxWait).default(0),
      until: z.enum(['any', 'finished', 'needs_you']).default('any'),
    },
    run: async ({ runId, wait_seconds, until }) => {
      const id = String(runId);
      const cond = String(until ?? 'any');
      let changed: boolean | undefined;
      if (Number(wait_seconds) > 0) {
        // Wait in rounds: each round ends on the first event for the run,
        // then the condition is checked against fresh state; an event that
        // does not satisfy it (a cost tick, under "finished") starts another
        // round with the time that is left. The clock is the outer bound.
        const deadline = Date.now() + Number(wait_seconds) * 1000;
        changed = false;
        for (;;) {
          const now = await findRun(id);
          const satisfied = now.status !== 'running'
            || (cond === 'needs_you' && (await needsOf(id)).length > 0)
            || (cond === 'any' && changed);
          if (satisfied) break;
          const left = Math.ceil((deadline - Date.now()) / 1000);
          if (left <= 0) break;
          const got = await waitForRunEvent(base, id, left, f);
          if (!got) break;
          changed = true;
        }
      }
      const r = await findRun(id);
      const needs = await needsOf(id);
      const doc = await get<{ doc: string }>(`/missiondoc?run=${encodeURIComponent(id)}`).then((d) => d.doc).catch(() => '');
      const dw = doneWhen(doc);
      const workers = (r.workers ?? []).map((w) => `  ${w.id} · ${w.status} · ${usd(w.costUsd)} · ${w.task.slice(0, 80)}`);
      const lines = [
        runLine(r),
        `director ${r.directorModel ?? 'default'} · workers ${r.workerModel ?? 'default'} · resumes ${r.resumes ?? 0}`,
        r.git ? `branch ${r.git.branch} from ${r.git.base}${r.git.pr ? ` · PR ${r.git.pr}${r.git.prState ? ` (${r.git.prState})` : ''}` : ''}` : null,
        dw.done.length + dw.open.length ? `DONE WHEN ${dw.done.length}/${dw.done.length + dw.open.length}${dw.open.length ? `\n  open: ${dw.open.join('\n  open: ')}` : ''}` : null,
        workers.length ? `crew:\n${workers.join('\n')}` : null,
        needs.length ? `NEEDS YOU (${needs.length}) — only a human can answer these, on the dashboard or the phone:\n${needs.map((n) => `  [${n.kind}] ${n.text}`).join('\n')}` : null,
        changed !== undefined ? (r.status !== 'running' ? 'finished' : needs.length && cond === 'needs_you' ? 'needs you' : changed ? 'changed: yes' : 'changed: no (timeout — call again)') : null,
      ].filter(Boolean);
      return { text: lines.join('\n'), data: { run: r, doneWhen: dw, needs, changed, waitedFor: Number(wait_seconds) > 0 ? cond : undefined } };
    },
  };

  const runReport: ToolDef = {
    name: 'run_report',
    description: 'What a finished run produced, in one call: the director\'s final report, DONE WHEN ticks, the files it changed with +/− counts, the branch, commit and pull request, spend and crew. For a running run it reports the state so far.',
    schema: { runId: z.string() },
    run: async ({ runId }) => {
      const id = String(runId);
      const r = await findRun(id);
      const [events, docRes, deck] = await Promise.all([
        get<{ events: Array<{ ts: number; event: string; data: Record<string, unknown> }> }>(`/runs/${encodeURIComponent(id)}/events`).then((d) => d.events).catch(() => []),
        get<{ doc: string }>(`/missiondoc?run=${encodeURIComponent(id)}`).catch(() => ({ doc: '' })),
        get<{ files: Array<{ path: string; status: string; additions: number; deletions: number; preexisting?: boolean }>; artifacts: Array<{ path: string; kind: string }>; totals: { files: number; additions: number; deletions: number }; baseline: { kind: string } }>(`/runs/${encodeURIComponent(id)}/deck`).catch(() => null),
      ]);
      // The director's last words: the final assistant text before the run ended.
      let report = '';
      for (const e of events) {
        if (e.event !== 'message' || e.data?.agent !== 'director') continue;
        const msg = e.data.msg as { type?: string; message?: { content?: Array<{ type: string; text?: string }> } } | undefined;
        const text = msg?.type === 'assistant' ? msg.message?.content?.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n') : '';
        if (text && text.trim().length > 40) report = text.trim();
      }
      const dw = doneWhen(docRes.doc);
      const files = deck?.files ?? [];
      const own = files.filter((x) => !x.preexisting);
      const fileLines = own.slice(0, 40).map((x) => `  ${x.status.padEnd(8)} ${x.path}  +${x.additions} −${x.deletions}`);
      const images = (deck?.artifacts ?? []).filter((a) => a.kind === 'image').length;
      const lines = [
        runLine(r),
        r.git ? `branch ${r.git.branch} from ${r.git.base}${r.git.commits ? ` · ${r.git.commits} commit${r.git.commits === 1 ? '' : 's'}` : ''}${r.git.pr ? ` · PR ${r.git.pr}${r.git.prState ? ` (${r.git.prState})` : ''}` : ' · no pull request yet (the human opens it from the run page)'}` : 'not a git repository',
        `DONE WHEN ${dw.done.length}/${dw.done.length + dw.open.length}${dw.open.length ? ` · open: ${dw.open.join(' · ')}` : ''}`,
        deck ? `changed: ${own.length} file${own.length === 1 ? '' : 's'} · +${deck.totals.additions} −${deck.totals.deletions}${images ? ` · ${images} screenshot${images === 1 ? '' : 's'}` : ''}${files.length > own.length ? ` · ${files.length - own.length} already dirty before the run` : ''}` : null,
        fileLines.length ? fileLines.join('\n') + (own.length > 40 ? `\n  … ${own.length - 40} more` : '') : null,
        `crew: ${(r.workers ?? []).length} worker${(r.workers ?? []).length === 1 ? '' : 's'} · ${(r.workers ?? []).filter((w) => w.status === 'done').length} done`,
        report ? `\nDirector's report:\n${report.slice(0, 4000)}` : '\nNo final report from the director yet.',
      ].filter(Boolean);
      return { text: lines.join('\n'), data: { run: r, doneWhen: dw, files: own, totals: deck?.totals, report } };
    },
  };

  const transcript: ToolDef = {
    name: 'run_transcript',
    description: 'The run\'s recent events, one line each, oldest first. since_ts (ms) narrows to what happened after a moment you already read.',
    schema: { runId: z.string(), since_ts: z.number().optional(), limit: z.number().int().min(1).max(500).default(50) },
    run: async ({ runId, since_ts, limit }) => {
      const { events } = await get<{ events: Array<{ ts: number; event: string; data: Record<string, unknown> }> }>(`/runs/${encodeURIComponent(String(runId))}/events`);
      const lines: Array<{ ts: number; line: string }> = [];
      for (const e of events) {
        if (since_ts && e.ts <= Number(since_ts)) continue;
        const line = eventLine(e.event, e.data ?? {});
        if (line) lines.push({ ts: e.ts, line });
      }
      const shown = lines.slice(-Number(limit ?? 50));
      return {
        text: shown.length ? shown.map((l) => `${new Date(l.ts).toISOString().slice(11, 19)} ${l.line}`).join('\n') : 'Nothing yet.',
        data: { events: shown, lastTs: shown.at(-1)?.ts ?? null },
      };
    },
  };

  const missionDoc: ToolDef = {
    name: 'mission_doc',
    description: 'The run\'s MISSION.md: DONE WHEN criteria, log, state — what the director itself keeps.',
    schema: { runId: z.string() },
    run: async ({ runId }) => {
      const { doc } = await get<{ doc: string }>(`/missiondoc?run=${encodeURIComponent(String(runId))}`);
      return { text: doc || 'MISSION.md not written yet.', data: { doc } };
    },
  };

  const memory: ToolDef = {
    name: 'project_memory',
    description: 'The project\'s memory (.foreman/MEMORY.md): what earlier crews learned — how to run and test it, ports, traps.',
    schema: { projectId: z.string() },
    run: async ({ projectId }) => {
      const d = await get<{ text: string; updatedAt?: number }>(`/projects/${encodeURIComponent(String(projectId))}/memory`);
      return { text: d.text || 'No memory yet.', data: d };
    },
  };

  const search: ToolDef = {
    name: 'search_runs',
    description: 'Runs across the fleet whose title, brief, project or folder match.',
    schema: { q: z.string().min(1) },
    run: async ({ q }) => {
      const d = await get<{ runs: RunSummary[] }>(`/search?q=${encodeURIComponent(String(q))}`);
      return { text: d.runs.length ? d.runs.map(runLine).join('\n') : 'No match.', data: d };
    },
  };

  const doctor: ToolDef = {
    name: 'doctor',
    description: 'What this machine has for missions: credentials, providers, browser, reach — the same checks as `foreman doctor`.',
    schema: {},
    run: async () => {
      const d = await get<{ checks: Array<{ name: string; status: string; detail: string; fix?: string }> }>('/doctor');
      return { text: d.checks.map((c) => `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name}: ${c.detail}${c.fix && c.status !== 'ok' ? `\n    ${c.fix}` : ''}`).join('\n'), data: d };
    },
  };

  const link: ToolDef = {
    name: 'link_project',
    description: 'Link a folder on this machine as a project (idempotent), or clone a Git URL under the projects root and link it. Returns the project id.',
    schema: { folder: z.string().optional(), git_url: z.string().optional(), branch: z.string().optional() },
    run: async ({ folder, git_url, branch }) => {
      if (git_url) {
        const started = await post<{ id?: string; dest?: string; error?: string }>('/projects/clone', { url: git_url, branch });
        if (!started.ok) return { text: `Could not start the clone: ${started.json.error ?? started.status}` };
        for (let i = 0; i < 600; i++) {
          const job = await get<{ state: string; progress: string; projectId?: string; error?: string }>(`/projects/clone/${started.json.id}`);
          if (job.state === 'done') return { text: `Cloned to ${started.json.dest} and linked as project ${job.projectId}.`, data: { projectId: job.projectId, folder: started.json.dest } };
          if (job.state === 'error') return { text: `Clone failed: ${job.error}` };
          await new Promise((r) => setTimeout(r, 1000));
        }
        return { text: 'The clone is still running; check fleet_status in a minute.' };
      }
      if (!folder) return { text: 'Give a folder path or a git_url.' };
      const abs = path.resolve(String(folder));
      const r = await post<{ project?: { id: string; name: string; folder: string }; error?: string }>('/projects', { folder: abs });
      if (!r.ok || !r.json.project) return { text: `Could not link ${abs}: ${r.json.error ?? r.status}` };
      return { text: `Linked ${r.json.project.name} (${r.json.project.id}) at ${r.json.project.folder}.`, data: r.json.project };
    },
  };

  const start: ToolDef = {
    name: 'start_mission',
    description: 'Start a mission on a project: the brief, a dollar cap, optional director/worker models and a browser. The mission runs in Foreman under its own governance; approvals and questions go to the human on the dashboard or phone, never through this tool. Follow with run_status(wait_seconds).',
    schema: {
      projectId: z.string(), brief: z.string().min(10), budgetUsd: z.number().positive(),
      director: z.string().optional(), worker: z.string().optional(), browser: z.boolean().optional(),
    },
    run: async ({ projectId, brief, budgetUsd, director, worker, browser }) => {
      const pid = String(projectId);
      const projects = (await get<{ projects: ProjectCard[] }>('/projects')).projects;
      const p = projects.find((x) => x.id === pid);
      if (!p) return { text: `No project ${pid}. fleet_status lists them; link_project adds one.` };
      if (isForemanCheckout(p.folder)) return { text: 'Refused: this folder is Foreman itself, and Foreman never runs missions on its own oversight infrastructure.' };
      const r = await post<{ ok?: boolean; error?: string }>('/run', {
        projectId: pid, mission: brief, budgetUsd, directorModel: director, workerModel: worker, browserTools: browser === true ? true : undefined,
      });
      if (r.status === 409) return { text: `${p.name} already has an active mission; see fleet_status. One mission per project at a time.` };
      if (!r.ok) return { text: `Could not start: ${r.json.error ?? r.status}` };
      // The run id lands a moment later; read it back so the caller can watch it.
      for (let i = 0; i < 20; i++) {
        const { runs } = await get<{ runs: RunSummary[] }>(`/runs?projectId=${encodeURIComponent(pid)}`);
        const live = runs.find((x) => x.status === 'running');
        if (live) return { text: `Started ${live.id} on ${p.name}, cap ${usd(live.budgetUsd)}. Watch it with run_status(runId, wait_seconds).`, data: { runId: live.id, projectId: pid } };
        await new Promise((res) => setTimeout(res, 250));
      }
      return { text: `Started on ${p.name}; the run id was not visible yet — list_runs will show it.`, data: { projectId: pid } };
    },
  };

  const steer: ToolDef = {
    name: 'steer',
    description: 'Send an operator note to a running director (a hint, a priority, a correction). Relays the human; it does not approve anything.',
    schema: { runId: z.string(), text: z.string().min(1) },
    run: async ({ runId, text }) => {
      const r = await post<{ ok?: boolean; error?: string }>('/steer', { runId, text });
      return { text: r.ok ? 'Delivered to the director for its next turn.' : `Could not steer: ${r.json.error ?? r.status}` };
    },
  };

  return [fleet, listRuns, runStatus, runReport, transcript, missionDoc, memory, search, doctor, link, start, steer];
}

/** Runs the MCP server over stdio until the client goes away. Nothing may be written to stdout but the protocol. */
// 127.0.0.1 rather than localhost: a stray process on the IPv6 wildcard
// (a worker's dev server, once) answers `localhost` first in most resolvers
// and would shadow Foreman for this client too. FOREMAN_URL overrides.
export async function serveMcp(base = process.env.FOREMAN_URL || 'http://127.0.0.1:4177'): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({ name: 'foreman', version: '1' });
  for (const t of foremanTools({ base })) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: Record<string, unknown>) => {
      try {
        const r = await t.run(args ?? {});
        return { content: [{ type: 'text' as const, text: r.text }], ...(r.data !== undefined ? { structuredContent: r.data as Record<string, unknown> } : {}) };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}
