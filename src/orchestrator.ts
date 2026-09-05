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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  query,
  tool,
  createSdkMcpServer,
  type McpServerConfig,
  type Query,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * A pushable async iterable of user messages — the director's streaming
 * prompt. Steering pushes additional messages; `close()` ends the
 * conversation once the mission's final turn has completed.
 */
class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string): boolean {
    if (this.closed) return false;
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Messages pushed but not yet consumed by the SDK's input pump. */
  get pending(): number {
    return this.queue.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
    };
  }
}
import { makePolicy, type PendingPermission } from './policy.js';
import type { AgentEnv } from './provider.js';
import { generateRunTitle } from './title.js';
import type { RunMeta, TokenUsage, WorkerMeta } from './types.js';

/** A run's usage before its first `result` message. */
function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Folds one SDK `result` message's `usage` object into a running total.
 *
 * Exported (pure, no `this`) so the accumulation is testable without
 * spinning up the Agent SDK: the shape it defends against is a message that
 * omits `usage` entirely, or reports it with some fields missing — both
 * observed across providers a gateway sits in front of — never a thrown
 * error or a poisoned NaN that a partial sum would otherwise carry forever.
 */
export function accumulateUsage(current: TokenUsage, raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: current.inputTokens + num(u.input_tokens),
    outputTokens: current.outputTokens + num(u.output_tokens),
    cacheReadTokens: current.cacheReadTokens + num(u.cache_read_input_tokens),
    cacheWriteTokens: current.cacheWriteTokens + num(u.cache_creation_input_tokens),
  };
}

/**
 * What Foreman keeps out of git inside a mission folder's .claude/.
 *
 * `settings.local.json` is the file an "always allow" grant creates. The
 * `.gitignore` line covers this file itself, so adding it introduces nothing
 * new to `git status` — without that line the fix would trade one untracked
 * file for another. Everything else in .claude/ (settings.json, agents,
 * commands) stays visible, since a project may legitimately track those.
 */
const LOCAL_IGNORE_LINES = ['settings.local.json', '.gitignore'];

/**
 * Caps that hold whatever the provider is. A dollar budget is meaningless on a
 * local model and actively wrong through a gateway (the SDK prices foreign
 * tokens with Anthropic's table), but "too many turns" and "too long" are true
 * everywhere — and a runaway agent is what a cap exists to stop, not a bill.
 */
// Sized to bound a runaway without shortening a legitimate mission. The
// director's own SDK limit is 150 turns, so anything tighter here would be a
// silent regression on runs that used to be governed by budget alone — these
// caps exist to give an UNMETERED run something that binds, not to second-guess
// a metered one that dollars already stop.
const DEFAULT_MAX_TURNS = 150;
const DEFAULT_MAX_SECONDS = 4 * 60 * 60;

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
   section. TICK THE BOXES AS YOU GO: the moment a milestone or a DONE WHEN
   criterion is actually verified, change its "- [ ]" to "- [x]" in the same
   turn. A log line saying something is done is not a substitute for ticking
   it. The doc is the mission's source of truth, not your context window, and
   it is what a resumed director reads to work out what is already finished —
   an unticked box costs the run the budget of proving that work again.
   SCALE THE DOC TO THE MISSION: a trivial task deserves a three-line doc
   (mission, one DONE WHEN, one milestone);
   never pad small missions with ceremony. The doc's existence is mandatory;
   its length is not.
2. DELEGATE IMPLEMENTATION. Use mcp__foreman__spawn_worker to have a worker do
   the building/editing. Give each worker one well-scoped, self-contained task
   with full context (paths, constraints, expected result). Use
   mcp__foreman__message_worker to send follow-ups or corrections to an
   existing worker. You may read files and run verification commands yourself,
   but implementation edits belong to workers.
3. VERIFY INDEPENDENTLY. Never trust a worker's "done". Read the files and run
   the checks yourself before ticking a milestone. Artifacts you produce
   (screenshots, reports, exports) must depict the FINAL state: if any file
   changes after you captured them, RE-CAPTURE before ticking that milestone.
   An artifact older than the code it documents is a false report.
   OPEN WHAT YOU CAPTURED. A screenshot is evidence only once you have looked
   at it. Never write "no defects observed" about an image you did not read
   back — saying it makes the report false even when the page is fine.
   SCROLL-REVEALED CONTENT IS THE COMMON TRAP. Modern pages start sections at
   "opacity: 0" and fade them in when they scroll into view, so a full-page
   capture taken without scrolling records blank space where the content is.
   Before a full-page screenshot: emulate "prefers-reduced-motion: reduce" if
   the page honours it, or scroll the whole page to the bottom, wait for the
   animations to settle, and scroll back. Then open the file and confirm the
   sections you expect are actually visible in it. A mostly-black screenshot is
   a failed capture, not a finished milestone.
4. REPORT WHAT YOU SEE. Judge the work as a competent professional would, not
   only against the letter of the acceptance criteria. If you observe a defect
   the criteria did not name — tap targets too small to use, unreadable
   contrast, a broken layout, a hazard, an obviously wrong result — fix it
   when it is clearly in scope, and otherwise say so plainly in your final
   summary and in MISSION.md. Staying silent about a problem you could see is
   a failed mission even when every listed box is ticked.
5. ESCALATE, DON'T POWER THROUGH. Anything irreversible, out of scope, or
   surprising: ask the human via mcp__foreman__ask_human and wait for the answer.
6. NEVER modify Foreman itself, its server, or any oversight tooling. Tooling
   failure is an escalation, never a self-repair.
7. When DONE WHEN is verified, update MISSION.md (all boxes ticked, final log
   entry) and end with a short summary of what was built and how you verified it.
`;

const WORKER_CHARTER = `
You are a FOREMAN WORKER. Complete exactly the task you were given, inside the
working directory. Never ask interactive questions — if you are blocked on a
decision you cannot make, print "BLOCKED: <your question>" and end your turn.
When finished, end with a concise report of what you did and how you checked it.
`;

/** Foreman's bundled Playwright MCP server, resolved from this repo. */
const PLAYWRIGHT_MCP_CLI = fileURLToPath(
  new URL('../node_modules/@playwright/mcp/cli.js', import.meta.url),
);

/** Claude subscription/quota exhaustion — an external pause, not a failure. */
const USAGE_LIMIT_RE = /out of usage credits|usage limit reached|upgrade to increase your usage/i;

interface WorkerRuntime extends WorkerMeta {
  q?: Query;
}

export class MissionRun {
  readonly meta: RunMeta;
  private directorQ?: Query;
  private readonly workers = new Map<string, WorkerRuntime>();
  private workerSeq = 0;
  private readonly runAllowed = new Set<string>();
  /** Set once the cap is passed; the wind-down turn is allowed, then the loop ends. */
  private budgetStopped = false;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  /** The director's streaming prompt; steering pushes into it. */
  private directorInput?: MessageStream;
  /** Director cost is cumulative per query; track the last figure for deltas. */
  private directorCostSeen = 0;
  private wasInterrupted = false;
  private usageLimited = false;
  /** Director turns taken, for the cap that applies to every provider. */
  private turns = 0;
  private startedAt = Date.now();

  constructor(
    meta: RunMeta,
    private readonly emit: Emitter,
    private readonly saveMeta: MetaSink,
    /**
     * Credential + wire per role, resolved once at dispatch.
     *
     * Two, not one, because a run may put its director on a capable provider
     * and its workers on a cheap or local one — that is the point of the
     * provider model, and it is decided by which model each role was given.
     * Passed in rather than derived here so exactly one module decides what an
     * agent can authenticate as; see provider.ts.
     */
    private readonly agentEnv: { director: AgentEnv; worker: AgentEnv },
  ) {
    this.meta = meta;
    // Usage and turns are counted from zero on a fresh run, but a resumed one
    // must keep the running total rather than quietly under-reporting
    // everything before the restart — same reasoning as the workers map below.
    this.meta.usage = meta.usage ?? emptyUsage();
    this.turns = meta.turns ?? 0;
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

  /**
   * Unsolicited operator guidance to the director, delivered at its next
   * turn boundary. Returns false once the mission is finishing.
   */
  steer(text: string): boolean {
    if (!this.directorInput || this.directorInput.isClosed) return false;
    this.emit('steer', { to: 'director', text, timing: 'next' });
    return this.directorInput.push(
      '[OPERATOR STEER — mid-mission note from the human overseer]\n' +
      `${text}\n\n` +
      'Acknowledge briefly, update .foreman/MISSION.md if this changes the plan ' +
      'or DONE WHEN, and continue the mission with this guidance applied.',
    );
  }

  async interrupt(): Promise<void> {
    this.wasInterrupted = true;
    this.directorInput?.close(); // no further turns; let the session wind down
    for (const w of this.workers.values()) {
      if (w.q) await w.q.interrupt().catch(() => {});
    }
    await this.directorQ?.interrupt().catch(() => {});
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Runs the mission to completion. Resolves when the director ends.
   *
   * Passing `resume` marks this as a continuation: the director is told to
   * re-verify state against MISSION.md rather than start the mission over.
   * `resume.sessionId` restores its prior context when available — it is
   * absent when the director's model changed, since a session cannot switch
   * models. Resuming WITHOUT a session is still a resume: the mission doc
   * and the working directory carry the state across.
   */
  async start(resume?: { sessionId?: string }): Promise<void> {
    const resumeSessionId = resume?.sessionId;
    const isResume = resume !== undefined;
    this.emit(isResume ? 'run_resumed' : 'run_started', {
      runId: this.meta.id,
      folder: this.meta.folder,
      mission: this.meta.mission,
      budgetUsd: this.meta.budgetUsd,
      costUsd: this.meta.costUsd,
      // Carried here, not only on `cost`, because a run that spends no
      // priceable dollars may never emit a cost event at all — and the UI
      // would then keep replaying an older run's meteredness forever.
      metered: this.meta.metered !== false,
      usage: this.meta.usage,
    });

    // Name the mission in parallel with running it: the title is display-only,
    // so nothing waits on it, and a resumed run that predates titling picks
    // one up here.
    if (!this.meta.title) void this.titleMission();

    const prompt = isResume
      ? `MISSION (unchanged): ${this.meta.mission}\n\n` +
        'This mission was interrupted (process restart, crash, usage limit, or an ' +
        'operator stop) and is now being resumed. DO NOT START OVER. ' +
        (resumeSessionId
          ? 'Do not trust your memory of progress: '
          : 'You are a NEW session with no memory of this mission at all — everything ' +
            'you know must come from disk. ') +
        're-read .foreman/MISSION.md if it exists ' +
        '(write it first if it does not), inspect the working directory to see which ' +
        'files already exist and what state they are in, and verify which milestones are ' +
        'actually complete. Keep completed work; do not rewrite files that already ' +
        'satisfy their milestone. Update the doc to match reality, then continue ' +
        'the mission to DONE WHEN. ' +
        this.budgetNote()
      : `MISSION: ${this.meta.mission}\n\n${this.budgetLine()} ` +
        `Working directory: ${this.meta.folder}. Begin by writing .foreman/MISSION.md, then execute the plan.`;

    try {
      // The mission doc directory ignores itself so missions never pollute
      // `git status` in real repositories. Inside the try so a bad folder
      // surfaces as a failed run, never an unhandled rejection.
      const foremanDir = path.join(this.meta.folder, '.foreman');
      await mkdir(foremanDir, { recursive: true });
      await writeFile(path.join(foremanDir, '.gitignore'), '*\n').catch(() => {});
      // Covers a .claude/ left by an earlier run; the one this run creates is
      // handled again on the way out.
      await this.ignoreLocalSettings();

      // Streaming prompt: the mission goes in first; steering pushes more
      // user messages, each starting a new director turn.
      const input = new MessageStream();
      this.directorInput = input;
      input.push(prompt);

      const q = query({
        prompt: input,
        options: {
          cwd: this.meta.folder,
          permissionMode: 'default',
          resume: resumeSessionId,
          model: this.meta.directorModel,
          maxTurns: 150,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: DIRECTOR_CHARTER },
          ...this.agentEnv.director,
          mcpServers: { foreman: this.makeTools(), ...this.browserServers() },
          canUseTool: this.policyFor('director'),
        },
      });
      this.directorQ = q;

      let lastTurnFailed = false;
      for await (const msg of this.directorQ as AsyncIterable<SDKMessage>) {
        const m = msg as Record<string, unknown>;
        if (typeof m.session_id === 'string') this.meta.directorSessionId = m.session_id;
        if (m.type === 'result') {
          // Cumulative per query() call — record only the delta per turn.
          const total = m.total_cost_usd as number | undefined;
          if (typeof total === 'number') {
            // Usage first: addCost emits the `cost` event carrying it, so
            // folding it in afterwards ships a snapshot one turn stale — the
            // meter showed `0 tok` on a run that had just spent 123k of them.
            this.turns++;
            this.addUsage(m.usage);
            this.addCost(total - this.directorCostSeen);
            this.directorCostSeen = total;
          } else {
            this.turns++;
            this.addUsage(m.usage);
          }
          lastTurnFailed = Boolean(m.is_error);
          this.noteUsageLimit(String(m.result ?? ''));

          // Enforce the cap against the director's own spend, at the only
          // point its cost is known. One wind-down turn, then stop — checked
          // before the pending-input test so a queued steer cannot extend a
          // run that has already been told this was its last turn.
          const windDown = this.budgetWindDown();
          if (windDown) {
            input.push(windDown);
          } else if (this.budgetStopped) {
            input.close();
            this.emit('message', { agent: 'director', msg });
            break;
          }
          // A result means the CLI is idle with all delivered input
          // processed (a steer consumed mid-turn is folded into that
          // turn's result). Only a steer still waiting in our queue
          // guarantees another turn; otherwise the mission is over.
          // Closing the input stream alone does not end the CLI
          // session, so break and dispose the query explicitly.
          if (input.pending === 0) {
            input.close();
            this.emit('message', { agent: 'director', msg });
            break;
          }
        }
        this.emit('message', { agent: 'director', msg });
      }
      input.close();
      await (q as AsyncGenerator<SDKMessage>).return?.(undefined as never).catch(() => {});
      // A run cut short by the cap is resumable, not complete — labelling it
      // 'done' would claim a mission finished that the budget ended.
      this.meta.status = this.wasInterrupted || this.usageLimited || this.budgetStopped ? 'interrupted'
        : lastTurnFailed ? 'error' : 'done';
    } catch (err) {
      this.meta.status = 'error';
      this.emit('run_error', { error: String(err) });
    } finally {
      // "Always allow" makes the SDK write .claude/settings.local.json into the
      // mission folder, which appears only once a grant happens — so this runs
      // after the work, not just before it.
      await this.ignoreLocalSettings();
      if (this.meta.status === 'running') this.meta.status = 'interrupted';

      // A director's exit is not proof its mission succeeded. The charter makes
      // it write DONE WHEN criteria and tick each one the moment it is actually
      // verified, so criteria still unticked at exit are the director's own
      // record that the work is unfinished — and reporting that as 'done' is
      // the one lie a mission runner cannot afford. Downgrading to
      // 'interrupted' is also the useful answer: it is what makes the run
      // resumable rather than closed.
      if (this.meta.status === 'done') {
        const unmet = await this.unmetCriteria();
        if (unmet?.length) {
          this.meta.status = 'interrupted';
          this.emit('mission_incomplete', {
            unmet,
            text: `The director ended with ${unmet.length} DONE WHEN criteri` +
              `${unmet.length === 1 ? 'on' : 'a'} still unticked, so this run is not done. ` +
              'Resume to continue it.',
          });
        }
      }
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

  /**
   * Asks the cheapest model for a short name for this mission, once.
   *
   * Fire-and-forget by design: it must not delay the director's first turn,
   * and a run whose title never arrives is displayed by its brief instead.
   * The fraction of a cent it costs is folded into the run's ledger rather
   * than spent invisibly.
   */
  private async titleMission(): Promise<void> {
    // Titling rides with the director: same provider, same bill.
    const named = await generateRunTitle(this.meta.mission, this.agentEnv.director);
    if (!named || this.meta.title) return;
    this.meta.title = named.title;
    this.emit('run_titled', { title: named.title });
    // addCost persists meta, so the title lands on disk with its own cost.
    if (named.costUsd > 0) this.addCost(named.costUsd);
    else this.saveMeta(this.meta);
  }

  /**
   * DONE WHEN criteria the director never ticked.
   *
   * Reads the mission doc rather than trusting the transcript, because the doc
   * is the mission's contract and the thing a resumed director reads back.
   * Only the DONE WHEN section counts: Plan milestones describe the route, and
   * a route can legitimately change, but the criteria are what "finished"
   * means for this mission.
   *
   * Null when there is nothing to judge by — no doc, or a doc with no criteria
   * — because absence of evidence is not evidence of failure, and a mission
   * whose director never wrote a doc has already failed more visibly.
   */
  private async unmetCriteria(): Promise<string[] | null> {
    const doc = await readFile(path.join(this.meta.folder, '.foreman', 'MISSION.md'), 'utf8')
      .catch(() => null);
    if (!doc) return null;

    const lines = doc.split('\n');
    const start = lines.findIndex((l) => /^#{1,6}\s*DONE\s*WHEN/i.test(l.trim()));
    if (start === -1) return null;

    const unmet: string[] = [];
    let sawAny = false;
    for (const line of lines.slice(start + 1)) {
      // The section ends at the next heading; checkboxes below it are the plan.
      if (/^#{1,6}\s/.test(line)) break;
      const box = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/);
      if (!box) continue;
      sawAny = true;
      if (box[1] === ' ') unmet.push(box[2].trim());
    }
    return sawAny ? unmet : null;
  }

  /**
   * A headless Playwright browser (its own profile — never the user's
   * Chrome), granted when the mission enabled browser tools.
   */
  private browserServers(): Record<string, McpServerConfig> {
    if (!this.meta.browserTools) return {};
    return {
      playwright: {
        type: 'stdio',
        // Absolute path: the server runs with the mission folder as cwd,
        // where npx cannot resolve Foreman's own dependency.
        command: process.execPath,
        args: [PLAYWRIGHT_MCP_CLI, '--headless', '--isolated'],
      },
    };
  }

  private policyFor(agent: string) {
    return makePolicy(agent, this.meta.folder, this.runAllowed, {
      onAutoAllow: (a, toolName, reason) => this.emit('auto_allowed', { agent: a, toolName, reason }),
      onAsk: (a, id, req) => this.emit('permission_request', { id, agent: a, ...req }),
      register: (id, pending) => void this.pendingPermissions.set(id, pending),
      unregister: (id) => {
        const existed = this.pendingPermissions.delete(id);
        if (existed) this.emit('permission_resolved', { id, behavior: 'aborted' });
        return existed;
      },
    }, { toolPolicy: this.meta.toolPolicy, autoAllowReadOnly: this.meta.autoAllowReadOnly });
  }

  /**
   * Detects Claude quota exhaustion in a result. This is not a mission
   * failure: no more work is possible until credits refresh, so the run
   * is marked interrupted (resumable) and the human is told plainly.
   */
  private noteUsageLimit(text: string): void {
    if (this.usageLimited || !USAGE_LIMIT_RE.test(text)) return;
    this.usageLimited = true;
    this.directorInput?.close(); // further turns would only burn retries
    this.emit('usage_limit', {
      text: 'Paused: your Claude usage credits are exhausted, so no agent can ' +
        'make progress right now. This is not a mission failure — the work so ' +
        'far is saved. Resume once credits refresh (or switch to a cheaper ' +
        'model in Settings, which resume will pick up).',
    });
  }

  private budgetNoticeSent = false;
  private budgetKillSent = false;

  /**
   * Keeps an "always allow" grant out of `git status`.
   *
   * Granting a tool for the run makes the SDK persist it to
   * `.claude/settings.local.json` in the mission folder — a file the operator
   * never asked for and, in a real repository, one they could commit by
   * accident. `.foreman/` solves this by ignoring itself wholesale; `.claude/`
   * cannot, because a project may legitimately track its own agents, commands
   * and shared settings.json there. So only the local-settings file is ignored,
   * an existing .gitignore is appended to rather than replaced, and the
   * directory is never created here — a mission that grants nothing leaves the
   * folder exactly as it found it.
   */
  private async ignoreLocalSettings(): Promise<void> {
    const dir = path.join(this.meta.folder, '.claude');
    if (!(await stat(dir).then((st) => st.isDirectory(), () => false))) return;

    const file = path.join(dir, '.gitignore');
    const existing = await readFile(file, 'utf8').catch(() => null);
    const lines = existing === null ? [] : existing.split('\n');
    const missing = LOCAL_IGNORE_LINES.filter(
      (rule) => !lines.some((line) => line.trim() === rule),
    );
    if (missing.length === 0) return;

    const prefix = existing === null || existing.endsWith('\n') ? (existing ?? '') : `${existing}\n`;
    await writeFile(file, `${prefix}${missing.join('\n')}\n`).catch(() => {});
  }


  private addCost(usd: number | undefined): void {
    if (typeof usd !== 'number') return;
    this.meta.costUsd += usd;
    this.saveMeta(this.meta);
    this.emitEconomics();
    this.enforceBudget();
  }

  /**
   * Folds one result message's token usage into the run total and persists
   * it. Called alongside addCost() from the same two call sites (director
   * loop, runWorker) so usage and cost are always in step — the honest
   * counterpart to a dollar figure that is not honest on every provider.
   */
  /**
   * The one event that carries a run's economics. Emitted whenever either half
   * changes — dollars OR tokens — because through a gateway the SDK often
   * reports no cost at all, and a UI told only about dollars would never learn
   * that this run has none to report.
   */
  private emitEconomics(): void {
    this.emit('cost', {
      costUsd: this.meta.costUsd,
      budgetUsd: this.meta.budgetUsd,
      usage: this.meta.usage,
      metered: this.meta.metered,
      turns: this.turns,
    });
  }

  private addUsage(raw: unknown): void {
    this.meta.usage = accumulateUsage(this.meta.usage ?? emptyUsage(), raw);
    this.meta.turns = this.turns;
    this.saveMeta(this.meta);
    this.emitEconomics();
  }

  /**
   * The cap is a real fence, not just a gate on new workers:
   *  - at 100% the director gets an in-band wind-down order (delivered into
   *    its live turn via the streaming input);
   *  - at 125% the run is interrupted outright.
   */
  private enforceBudget(): void {
    const { costUsd, budgetUsd } = this.meta;
    if (budgetUsd <= 0) return;
    // The hard 125% kill is the one that ends a run outright, so it must never
    // fire on a figure that is not real money. An unmetered run is bounded by
    // the turn and time caps in capReached() instead.
    if (this.meta.metered === false) return;
    if (!this.budgetKillSent && costUsd >= budgetUsd * 1.25) {
      this.budgetKillSent = true;
      this.budgetNoticeSent = true; // the kill supersedes the wind-down notice
      this.emit('budget_alert', {
        level: 'exceeded', costUsd, budgetUsd,
        text: `Budget overrun past 125% ($${costUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}) — run interrupted.`,
      });
      void this.interrupt();
      return;
    }
    if (!this.budgetNoticeSent && costUsd >= budgetUsd) {
      this.budgetNoticeSent = true;
      this.emit('budget_alert', {
        level: 'reached', costUsd, budgetUsd,
        text: `Budget cap reached ($${costUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}) — director ordered to wind down.`,
      });
      this.directorInput?.push(
        '[BUDGET ENFORCEMENT — automated notice]\n' +
        `The run has reached its budget cap: $${costUsd.toFixed(2)} spent of ` +
        `$${budgetUsd.toFixed(2)}. Stop starting new work now. Update .foreman/MISSION.md ` +
        'with the true state, summarize what is done and what is not, and end your turn. ' +
        'If finishing is essential, ask the human for a budget increase via ' +
        'mcp__foreman__ask_human. The run will be force-interrupted at 125% of budget.',
      );
    }
  }

  /**
   * What the director is told about its budget, in the units that are true.
   *
   * Quoting dollars on an unmetered run is not a cosmetic slip: the figure is
   * Anthropic pricing applied to somebody else's tokens, and a director told
   * it has overspent behaves accordingly — it stops delegating and asks for
   * authorisation it does not need. That is exactly what happened on the first
   * mixed-provider run, and a resumed session carries the belief in its
   * restored context long after the cap itself is gone.
   */
  private budgetLine(): string {
    if (this.meta.metered === false) {
      return `This run is not billed per token, so there is no spend cap. ` +
        `It is bounded by ${this.meta.maxTurns ?? DEFAULT_MAX_TURNS} director turns.`;
    }
    return `Budget: $${this.meta.budgetUsd.toFixed(2)} total for this run.`;
  }

  private budgetNote(): string {
    if (this.meta.metered === false) {
      return 'Budget note: this run is not billed per token — any earlier message ' +
        'about a spend cap no longer applies, and you do not need authorisation ' +
        'to continue. Carry on to DONE WHEN.';
    }
    return `Budget note: $${this.meta.costUsd.toFixed(2)} of ` +
      `$${this.meta.budgetUsd.toFixed(2)} is already spent.`;
  }

  /** Appended to worker reports so the director can see the true burn rate
   *  (its own turn costs are invisible to it otherwise). */
  private costFooter(): string {
    if (this.meta.metered === false) {
      const u = this.meta.usage;
      const tokens = u ? u.inputTokens + u.outputTokens : 0;
      return `\n\n[Run so far: ${this.turns} director turns` +
        `${tokens ? `, ${Math.round(tokens / 1000)}k tokens` : ''} — not billed per token]`;
    }
    return `\n\n[Run cost so far: $${this.meta.costUsd.toFixed(2)} of ` +
      `$${this.meta.budgetUsd.toFixed(2)} budget — includes director turns]`;
  }

  /** How far past its limits the run is, as a wind-down reason — or null. */
  private capReached(): string | null {
    if (this.turns >= (this.meta.maxTurns ?? DEFAULT_MAX_TURNS)) {
      return `TURN CAP REACHED: ${this.turns} director turns.`;
    }
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const maxSeconds = this.meta.maxSeconds ?? DEFAULT_MAX_SECONDS;
    if (elapsed >= maxSeconds) {
      return `TIME CAP REACHED: ${Math.round(elapsed / 60)} minutes.`;
    }
    // Money only binds where the figure is real. Enforcing it through a
    // gateway ends working runs over spend that never happened.
    if (this.meta.metered === false) return null;
    if (this.meta.costUsd < this.meta.budgetUsd) return null;
    return `BUDGET CAP REACHED: $${this.meta.costUsd.toFixed(2)} of $${this.meta.budgetUsd.toFixed(2)}.`;
  }

  private overBudget(): string | null {
    const cap = this.capReached();
    if (!cap) return null;
    if (this.meta.metered === false) {
      return `${cap} Do not start new work. Update MISSION.md, summarize the state, and stop.`;
    }
    return (
      `BUDGET EXHAUSTED: $${this.meta.costUsd.toFixed(2)} spent of ` +
      `$${this.meta.budgetUsd.toFixed(2)} cap. Do not start new work. Update MISSION.md, ` +
      `summarize the state, and stop (or ask the human for a budget increase via ask_human).`
    );
  }

  /**
   * The cap applied to the director's own turns, not just to delegation.
   *
   * overBudget() only reaches the director through spawn_worker/message_worker,
   * so a director that stops delegating and keeps working never sees it — the
   * run overshoots by however much its remaining turns cost. Checked here at
   * every turn boundary instead.
   *
   * Returns the wind-down instruction on the first turn past the cap, and null
   * afterwards: exactly one bounded turn to tick MISSION.md and summarise, then
   * {@link budgetExhausted} ends the loop. Killing the director outright would
   * be a harder stop but would strand the mission doc mid-flight, which is the
   * state a resume can least afford.
   */
  private budgetWindDown(): string | null {
    const cap = this.capReached();
    if (!cap || this.budgetStopped) return null;
    this.budgetStopped = true;
    this.emit('budget_stop', {
      costUsd: this.meta.costUsd,
      budgetUsd: this.meta.budgetUsd,
      metered: this.meta.metered !== false,
      reason: cap,
    });
    return (
      `${cap} ` +
      'This is your LAST turn — the run ends when it does. Do not start new work, do not ' +
      'spawn or message workers, and do not begin any verification you have not already ' +
      'finished. Use this turn only to: tick every MISSION.md box you have genuinely ' +
      'verified, add a final log line naming what is left undone, and reply with a short ' +
      'summary of where the mission stands so it can be resumed with a larger budget.'
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
        ...this.agentEnv.worker,
        mcpServers: this.browserServers(),
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
          this.noteUsageLimit(report);
          // Same ordering rule as the director loop: the cost event carries
          // usage, so usage has to be current before it is emitted.
          this.addUsage(m.usage);
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
        return text(`[${id}${isError ? ' FAILED' : ' finished'}] ${report || '(no report)'}${this.costFooter()}`);
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
        return text(`[${worker_id}${isError ? ' FAILED' : ' finished'}] ${report || '(no report)'}${this.costFooter()}`);
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
