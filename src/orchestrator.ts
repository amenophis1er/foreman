/**
 * MissionRun — one director-led mission: planning, delegation, verification.
 *
 * Responsibilities:
 *  - Spawn the director session with its charter and in-process MCP tools
 *    (spawn_worker / message_worker / ask_human).
 *  - Run workers as separate, resumable SDK sessions; a worker call blocks
 *    inside the director's tool call, so its report lands in the director's
 *    context as an ordinary tool result.
 *  - Enforce the per-run budget before any new worker work starts.
 *  - Emit every observable event through the injected {@link Emitter}, which
 *    both broadcasts to live clients and persists to the run's event log.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  query,
  tool,
  createSdkMcpServer,
  type Query,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { makePolicy, type PendingPermission } from './policy.js';
import type { RunMeta, WorkerMeta } from './types.js';

/** Broadcasts to SSE clients and appends to the run's event log. */
export type Emitter = (event: string, data: unknown) => void;

/** Persists updated run metadata (fire-and-forget from the run's viewpoint). */
export type MetaSink = (meta: RunMeta) => void;

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

interface WorkerRuntime extends WorkerMeta {
  q?: Query;
}

export class MissionRun {
  readonly meta: RunMeta;
  private directorQ?: Query;
  private readonly workers = new Map<string, WorkerRuntime>();
  private workerSeq = 0;
  private readonly runAllowed = new Set<string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();

  constructor(
    meta: RunMeta,
    private readonly emit: Emitter,
    private readonly saveMeta: MetaSink,
  ) {
    this.meta = meta;
    // Rehydrate orchestrator state from persisted metadata so a resumed run
    // behaves like the original process: message_worker can reach prior
    // workers, new worker ids never collide with old ones, and "always
    // allow" grants survive.
    for (const w of meta.workers) {
      this.workers.set(w.id, { ...w });
      const n = Number(w.id.match(/^worker-(\d+)$/)?.[1] ?? 0);
      if (n > this.workerSeq) this.workerSeq = n;
    }
    for (const t of meta.allowedTools ?? []) this.runAllowed.add(t);
  }

  // -- public control surface (called by the HTTP layer) --------------------

  get pendingPermissionIds(): string[] {
    return [...this.pendingPermissions.keys()];
  }

  get pendingQuestionIds(): string[] {
    return [...this.pendingQuestions.keys()];
  }

  resolvePermission(id: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): boolean {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;
    this.pendingPermissions.delete(id);
    let result: PermissionResult;
    if (decision === 'allow_always') {
      this.runAllowed.add(pending.toolName);
      this.meta.allowedTools = [...this.runAllowed];
      this.saveMeta(this.meta);
      result = { behavior: 'allow', updatedPermissions: pending.suggestions };
    } else if (decision === 'allow') {
      result = { behavior: 'allow' };
    } else {
      result = { behavior: 'deny', message: message || 'Denied by user.' };
    }
    pending.resolve(result);
    this.emit('permission_resolved', { id, behavior: decision });
    return true;
  }

  answerQuestion(id: string, text: string): boolean {
    const resolve = this.pendingQuestions.get(id);
    if (!resolve) return false;
    this.pendingQuestions.delete(id);
    resolve(text);
    return true;
  }

  async interrupt(): Promise<void> {
    for (const w of this.workers.values()) {
      if (w.q) await w.q.interrupt().catch(() => {});
    }
    await this.directorQ?.interrupt().catch(() => {});
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Runs the mission to completion. Resolves when the director ends.
   * With `resumeSessionId`, the director session is resumed with its prior
   * context and instructed to re-verify state against MISSION.md first.
   */
  async start(resumeSessionId?: string): Promise<void> {
    this.emit(resumeSessionId ? 'run_resumed' : 'run_started', {
      runId: this.meta.id,
      folder: this.meta.folder,
      mission: this.meta.mission,
      budgetUsd: this.meta.budgetUsd,
      costUsd: this.meta.costUsd,
    });

    const prompt = resumeSessionId
      ? `MISSION (unchanged): ${this.meta.mission}\n\n` +
        'This mission was interrupted (process restart or crash) and is now being resumed. ' +
        'Do not trust your memory of progress: re-read .foreman/MISSION.md if it exists ' +
        '(write it first if it does not), inspect the working directory, and verify which ' +
        'milestones are actually complete. Update the doc to match reality, then continue ' +
        'the mission to DONE WHEN. ' +
        `Budget note: $${this.meta.costUsd.toFixed(2)} of $${this.meta.budgetUsd.toFixed(2)} is already spent.`
      : `MISSION: ${this.meta.mission}\n\nBudget: $${this.meta.budgetUsd.toFixed(2)} total for this run. ` +
        `Working directory: ${this.meta.folder}. Begin by writing .foreman/MISSION.md, then execute the plan.`;

    try {
      // The mission doc directory ignores itself so missions never pollute
      // `git status` in real repositories. Inside the try so a bad folder
      // surfaces as a failed run, never an unhandled rejection.
      const foremanDir = path.join(this.meta.folder, '.foreman');
      await mkdir(foremanDir, { recursive: true });
      await writeFile(path.join(foremanDir, '.gitignore'), '*\n').catch(() => {});

      const q = query({
        prompt,
        options: {
          cwd: this.meta.folder,
          permissionMode: 'default',
          resume: resumeSessionId,
          model: this.meta.directorModel,
          maxTurns: 150,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: DIRECTOR_CHARTER },
          mcpServers: { foreman: this.makeTools() },
          canUseTool: this.policyFor('director'),
        },
      });
      this.directorQ = q;

      for await (const msg of this.directorQ as AsyncIterable<SDKMessage>) {
        const m = msg as Record<string, unknown>;
        if (typeof m.session_id === 'string') this.meta.directorSessionId = m.session_id;
        if (m.type === 'result') {
          this.addCost(m.total_cost_usd as number | undefined);
          this.meta.status = m.is_error ? 'error' : 'done';
        }
        this.emit('message', { agent: 'director', msg });
      }
    } catch (err) {
      this.meta.status = 'error';
      this.emit('run_error', { error: String(err) });
    } finally {
      if (this.meta.status === 'running') this.meta.status = 'interrupted';
      this.meta.endedAt = Date.now();
      this.saveMeta(this.meta);
      this.emit('run_finished', {
        status: this.meta.status,
        costUsd: this.meta.costUsd,
        directorSessionId: this.meta.directorSessionId,
      });
    }
  }

  // -- internals ------------------------------------------------------------

  private policyFor(agent: string) {
    return makePolicy(agent, this.meta.folder, this.runAllowed, {
      onAutoAllow: (a, toolName) => this.emit('auto_allowed', { agent: a, toolName }),
      onAsk: (a, id, req) => this.emit('permission_request', { id, agent: a, ...req }),
      register: (id, pending) => void this.pendingPermissions.set(id, pending),
      unregister: (id) => {
        const existed = this.pendingPermissions.delete(id);
        if (existed) this.emit('permission_resolved', { id, behavior: 'aborted' });
        return existed;
      },
    });
  }

  private addCost(usd: number | undefined): void {
    if (typeof usd !== 'number') return;
    this.meta.costUsd += usd;
    this.saveMeta(this.meta);
    this.emit('cost', { costUsd: this.meta.costUsd, budgetUsd: this.meta.budgetUsd });
  }

  private overBudget(): string | null {
    if (this.meta.costUsd < this.meta.budgetUsd) return null;
    return (
      `BUDGET EXHAUSTED: $${this.meta.costUsd.toFixed(2)} spent of ` +
      `$${this.meta.budgetUsd.toFixed(2)} cap. Do not start new work. Update MISSION.md, ` +
      `summarize the state, and stop (or ask the human for a budget increase via ask_human).`
    );
  }

  private async runWorker(workerId: string, prompt: string, resumeSessionId?: string):
    Promise<{ report: string; isError: boolean }> {
    const existing = this.workers.get(workerId);
    const w: WorkerRuntime = existing ?? {
      id: workerId, status: 'running', costUsd: 0, task: prompt.slice(0, 500),
    };
    w.status = 'running';
    this.workers.set(workerId, w);
    this.syncWorkersMeta();
    this.emit('worker_started', {
      id: workerId, task: prompt.slice(0, 200), resumed: Boolean(resumeSessionId),
    });

    const q = query({
      prompt,
      options: {
        cwd: this.meta.folder,
        permissionMode: 'default',
        resume: resumeSessionId,
        model: this.meta.workerModel,
        maxTurns: 60,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: WORKER_CHARTER },
        canUseTool: this.policyFor(workerId),
      },
    });
    w.q = q;

    let report = '';
    let isError = false;
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const m = msg as Record<string, unknown>;
        if (typeof m.session_id === 'string') w.sessionId = m.session_id;
        if (m.type === 'result') {
          report = String(m.result ?? '');
          isError = Boolean(m.is_error);
          this.addCost(m.total_cost_usd as number | undefined);
          w.costUsd += (m.total_cost_usd as number | undefined) ?? 0;
        }
        this.emit('message', { agent: workerId, msg });
      }
    } catch (err) {
      isError = true;
      report = report || `Worker crashed: ${String(err)}`;
    } finally {
      w.q = undefined;
      w.status = isError ? 'error' : 'done';
      this.syncWorkersMeta();
      this.emit('worker_finished', { id: workerId, status: w.status, sessionId: w.sessionId });
    }
    return { report, isError };
  }

  private syncWorkersMeta(): void {
    this.meta.workers = [...this.workers.values()].map(({ q: _q, ...w }) => w);
    this.saveMeta(this.meta);
  }

  private makeTools() {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

    const spawnWorker = tool(
      'spawn_worker',
      'Spawn a worker agent to execute one self-contained implementation task in the ' +
      'working directory. Blocks until the worker finishes and returns its final report. ' +
      'Include all context the worker needs: it does not see your conversation.',
      { task: z.string().describe('Full task description with context, paths, and the expected result') },
      async ({ task }) => {
        const stop = this.overBudget();
        if (stop) return text(stop);
        const id = `worker-${++this.workerSeq}`;
        const { report, isError } = await this.runWorker(id, task);
        return text(`[${id}${isError ? ' FAILED' : ' finished'}] ${report || '(no report)'}`);
      },
    );

    const messageWorker = tool(
      'message_worker',
      'Send a follow-up message to an existing worker (correction, next step, answer to a ' +
      "BLOCKED question). Resumes that worker's session with its prior context intact. " +
      'Blocks until the worker finishes and returns its report.',
      {
        worker_id: z.string().describe('The worker id, e.g. "worker-1"'),
        message: z.string().describe('The follow-up instruction or answer'),
      },
      async ({ worker_id, message }) => {
        const stop = this.overBudget();
        if (stop) return text(stop);
        const w = this.workers.get(worker_id);
        if (!w?.sessionId) return text(`No resumable worker "${worker_id}".`);
        const { report, isError } = await this.runWorker(worker_id, message, w.sessionId);
        return text(`[${worker_id}${isError ? ' FAILED' : ' finished'}] ${report || '(no report)'}`);
      },
    );

    const askHuman = tool(
      'ask_human',
      'Ask the human overseer a question and wait for their answer. Use for anything ' +
      'irreversible, out of scope, over budget, or that only a human can decide.',
      { question: z.string().describe('The question, with enough context to answer it') },
      async ({ question }) => {
        const id = `q-${Date.now()}-${this.pendingQuestions.size}`;
        this.emit('question', { id, question });
        const answer = await new Promise<string>((resolve) => this.pendingQuestions.set(id, resolve));
        this.emit('question_answered', { id });
        return text(`Human answered: ${answer}`);
      },
    );

    return createSdkMcpServer({ name: 'foreman', tools: [spawnWorker, messageWorker, askHuman] });
  }
}
