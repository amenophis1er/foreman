/**
 * MissionRun — one director-led mission: planning, delegation, verification.
 *
 * Responsibilities:
 *  - Spawn the director session with its charter and in-process MCP tools
 *    (spawn_worker / request_review / check_workers / wait_for_worker /
 *    message_worker / ask_human).
 *  - Run workers as separate, resumable SDK sessions, concurrently with the
 *    director's own turn: spawn_worker returns as soon as the worker exists,
 *    and the director reads progress and results back through check_workers
 *    and wait_for_worker. Nothing holds the director's turn open longer than
 *    a bounded wait, so it can run several workers at once and notice one
 *    while another is still working.
 *  - Give each worker one Foreman tool of its own, report_progress, so the
 *    director's view of a worker is not only inferred from its tool calls
 *    but includes what the worker itself says it has done and is stuck on.
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
import { WORK_DIR, makePolicy, type PendingPermission } from './policy.js';
import { PLAYWRIGHT_MCP_CLI } from './browser.js';
import type { AgentEnv } from './provider.js';
import { generateRunTitle } from './title.js';
import { combineBasis, costBasisOf, isPriced, type CostBasis } from './types.js';
import { priceUsage, type ModelPrice } from './prices.js';
import { captureBaseline, deckFor, type Deck } from './deck.js';
import { changeFingerprint } from './gitwork.js';
import { memorySection, readMemory, writeMemory } from './memory.js';
import {
  REVIEWER_TOOL_POLICY, diffHash, parseVerdict, reviewBlockers, reviewBriefFor, unreviewedText,
  type ReviewBlocker, type ReviewVerdict,
} from './crew.js';
import type { RunMeta, ToolPolicy, TokenUsage, WorkerMeta, WorkerProgress } from './types.js';

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
  const d = normalizeUsage(raw);
  return {
    inputTokens: current.inputTokens + d.inputTokens,
    outputTokens: current.outputTokens + d.outputTokens,
    cacheReadTokens: current.cacheReadTokens + d.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + d.cacheWriteTokens,
  };
}

/**
 * One SDK `usage` object as token counts — the delta a single result message
 * reports, before it is folded into the run total.
 *
 * Separate from accumulateUsage() because pricing needs the delta on its own:
 * charging a per-token rate against the running total would bill every turn
 * for every turn before it.
 */
export function normalizeUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
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
 * The sanctioned scratch space inside a mission folder — see the definition
 * in policy.ts for why it exists and why it lives there. Re-exported because
 * this module is where callers already look for it.
 */
export { WORK_DIR };

/**
 * How long an approval card or a director question waits for the human
 * before it is answered with its unattended default.
 *
 * An orchestrator must survive its human being away. A planned mission once
 * sat most of an hour on a scratch-file write, and had the human been asleep
 * it would have died on a question whose answer was knowable in advance. Ten
 * minutes is long enough that an attended human — one who is watching the
 * run, or has the badge in a tab — will have answered, and short enough that
 * an unattended run loses a fraction of its wall clock to the wait rather than
 * all of it. The default on expiry is the SAFE answer, never the permissive
 * one: a permission is denied with a redirect to the workspace, a question is
 * answered "decide yourself and record it". Per-run override: `askTimeoutMs`
 * (0 disables, for a run someone intends to babysit).
 */
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;

// The ask timer lives in ask.ts now, shared with the planner's ask_user: the
// rule — fire once, never after cancel, `0` means never — must be one
// implementation, not two that drift. Re-exported so callers and tests that
// learned it here keep working.
import { armAskTimeout } from './ask.js';
export { armAskTimeout };

function unattendedMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * What a tool gets back when its approval card expired unanswered. Denies,
 * and says where to redo the work — the same redirect the temp-dir rule
 * gives, because the answer to "may I write outside?" from an absent human
 * is the answer the charter already gave.
 */
export function unattendedDenyMessage(afterMs: number): string {
  return `Auto-denied after ${unattendedMinutes(afterMs)} minutes unattended — Foreman does not ` +
    `block a mission on a human who is away. Redo this inside the workspace (${WORK_DIR}/) or ` +
    'record in MISSION.md why the outside is needed.';
}

/**
 * What the director gets back when its `ask_human` expired unanswered. Not a
 * refusal — the mission continues — but a decision handed back with the two
 * conditions that make an unsupervised decision acceptable: write it down,
 * and do not ask the same thing again.
 */
export function unattendedAnswer(afterMs: number): string {
  return `No answer after ${unattendedMinutes(afterMs)} minutes — the human is away. Decide ` +
    'yourself, record the decision and its reasoning in MISSION.md, and continue; do not ask ' +
    'again unless the mission cannot proceed at all.';
}

/**
 * Ensures every rule in `lines` appears in the gitignore at `file`, appending
 * only the ones missing.
 *
 * Shared by the `.claude/` and `.foreman/` ignore files, which need the same
 * care: an existing file is appended to, never replaced (a project may have
 * its own rules there); a file without a trailing newline gets one before the
 * new rules so the last existing rule is not fused with the first new one; a
 * missing file is created. Each list ends with `.gitignore` itself so the file
 * introduces nothing new to `git status` — without that line the fix would
 * trade one untracked file for another. Write failures are swallowed: this is
 * hygiene, and a read-only folder must not fail the run over it.
 */
export async function ensureIgnoreLines(file: string, lines: readonly string[]): Promise<void> {
  const existing = await readFile(file, 'utf8').catch(() => null);
  const present = existing === null ? [] : existing.split('\n');
  const missing = lines.filter((rule) => !present.some((line) => line.trim() === rule));
  if (missing.length === 0) return;

  // An empty file is also "nothing to separate from": without the `!existing`
  // case it would gain a leading blank line.
  const prefix = !existing || existing.endsWith('\n') ? (existing ?? '') : `${existing}\n`;
  await writeFile(file, `${prefix}${missing.join('\n')}\n`).catch(() => {});
}

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

/**
 * The same idea counted in tokens, for the same reason the turn cap exists.
 *
 * A turn cap bounds how many times the director speaks, not how much it says,
 * and those come apart badly on a free or unpriced run: 150 turns over a large
 * context is millions of tokens that nothing here was watching. It binds only
 * where dollars cannot — a priced run already has a real cap, and this one
 * must never end it first. Sized from the ledger, not from a hunch: cache
 * reads are most of a director loop's traffic, and finished missions on this
 * machine have run to 8–16M tokens total (a 5M figure was first proposed and
 * would have cut several of them short). 20M is clear of every honest run
 * seen so far and still well inside what a runaway reaches before the clock.
 */
export const DEFAULT_MAX_TOKENS = 20_000_000;

/** The cap behind a capReached() sentence, as the run record stores it. */
/**
 * Is it time to tell the director to start winding down? True once spend
 * crosses the warn threshold and while it is still under the cap — past the
 * cap the wind-down order takes over, and a warning then would be noise.
 */
export function budgetWarnDue(costUsd: number, budgetUsd: number, warnAt: number | undefined): boolean {
  if (!Number.isFinite(warnAt as number) || (warnAt as number) <= 0 || (warnAt as number) >= 100) return false;
  if (!(budgetUsd > 0)) return false;
  return costUsd >= budgetUsd * ((warnAt as number) / 100) && costUsd < budgetUsd;
}

/**
 * A run the budget stopped, whose own DONE WHEN criteria are all ticked, is
 * done: it reached its criteria and then reached its limit, in that order.
 * Only for the budget — a human interrupt or a usage limit says nothing
 * about the work — and only when the doc actually had criteria to tick.
 */
export function doneAtCap(
  flags: { budgetStopped: boolean; wasInterrupted: boolean; usageLimited: boolean },
  unmet: string[] | null,
): boolean {
  if (!flags.budgetStopped || flags.wasInterrupted || flags.usageLimited) return false;
  return Array.isArray(unmet) && unmet.length === 0;
}

/**
 * The lines under the mission doc's DONE WHEN heading, to the next heading —
 * or null when the doc has no such section.
 *
 * One parse, two readers: the end-of-run check that counts unticked boxes, and
 * the reviewer's brief, which quotes the criteria verbatim so the reviewer
 * judges the diff against the same contract Foreman judges the run against.
 * Two parsers would eventually disagree about what "the criteria" are, and the
 * one place that must not happen is the gate.
 */
export function doneWhenSection(doc: string): string[] | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s*DONE\s*WHEN/i.test(l.trim()));
  if (start === -1) return null;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // The section ends at the next heading; checkboxes below it are the plan.
    if (/^#{1,6}\s/.test(line)) break;
    out.push(line);
  }
  return out;
}

/**
 * How much of the run's diff fits in a reviewer's brief. The deck is already
 * capped per file and per file count; this is the cap on the whole thing, so a
 * mission that touched two hundred files does not hand its reviewer a prompt
 * nothing will read to the end of. When it bites, the brief says so and the
 * reviewer is told to open the files itself — it has Read, Glob and Grep.
 */
export const REVIEW_DIFF_MAX_CHARS = 120_000;

/**
 * A deck rendered as one diff text for the reviewer, with a header line per
 * file so a truncated body is still attributable. `truncated` is true when
 * this cut anything OR when the deck had already cut a file's own diff —
 * either way the reviewer is looking at less than the whole change and must
 * be told, because a reviewer that believes it saw everything passes on what
 * it did not see.
 */
export function renderDeckDiff(deck: Deck, max = REVIEW_DIFF_MAX_CHARS): { diff: string; truncated: boolean } {
  const files = deck.files ?? [];
  let truncated = files.length < (deck.totals?.files ?? files.length);
  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    if (f.truncated) truncated = true;
    const head = `--- ${f.path} (${f.status} +${f.additions} -${f.deletions})`;
    const body = f.binary ? '(binary file)' : (f.diff ?? '(no diff available)');
    const block = `${head}\n${body}`;
    if (used + block.length > max) { truncated = true; break; }
    parts.push(block);
    used += block.length + 1;
  }
  const diff = parts.join('\n') || (files.length ? '' : '(this run changed no files)');
  return { diff, truncated };
}

export function stopReasonOf(cap: string): 'budget' | 'turns' | 'time' | 'tokens' {
  if (cap.startsWith('TURN')) return 'turns';
  if (cap.startsWith('TIME')) return 'time';
  if (cap.startsWith('TOKEN')) return 'tokens';
  return 'budget';
}

/**
 * The token cap as a director should read it: "5M tokens", not "5000000".
 * A budget is only useful if the agent it constrains can hold it in mind, and
 * a raw seven-digit figure in a prompt is one more thing to misread.
 */
export function tokenCapLabel(n: number): string {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M tokens`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}k tokens`;
  return `${n} tokens`;
}

/**
 * How long a worker may say nothing at all before it is treated as stalled.
 *
 * The SDK emits a message for every tool call, every result, every retry — so
 * total silence is not a worker thinking hard, it is a worker that is not
 * coming back. Observed in the wild: a worker sat silent for eight minutes,
 * failed with `error: unknown`, retried, and sat silent again, while the
 * director waited inside spawn_worker and the run looked alive from every
 * angle. Nothing stopped it, because nothing was watching.
 *
 * Set well above a slow first token — a large prompt to a local model can
 * legitimately take minutes — because the cost of being wrong in each
 * direction is not symmetric. Killing a slow-but-working worker throws away
 * real progress; waiting too long only costs time on a worker that was never
 * going to answer.
 */
const DEFAULT_WORKER_SILENCE_MS = 8 * 60_000;

/**
 * Grace between the wall-clock cap and the watchdog that enforces it anyway.
 *
 * The graceful path — capReached() at a turn boundary, one last turn to tick
 * MISSION.md and summarise — is much better than being killed, so it gets
 * first refusal. But it only runs at a turn boundary, and a director blocked
 * inside a tool call never reaches one: the caps that are supposed to bound
 * every run were, in that state, bounding nothing at all.
 */
const CAP_WATCHDOG_GRACE_MS = 5 * 60_000;

/**
 * Watches for silence, and says so once.
 *
 * Extracted rather than inlined because it is the part with the actual rule
 * in it — reset on any sign of life, fire exactly once, never fire after it
 * is stopped — and a watchdog nobody has watched fire is not a watchdog.
 *
 * The poll interval scales with the threshold so a short one can be tested in
 * milliseconds while a production eight-minute threshold still costs one
 * wakeup every thirty seconds.
 */
export function watchSilence(
  silenceMs: number,
  onStall: (quietForMs: number) => void,
): { touch(): void; stop(): void } {
  let last = Date.now();
  let fired = false;
  const every = Math.max(10, Math.min(30_000, Math.floor(silenceMs / 4)));
  const timer = setInterval(() => {
    if (fired) return;
    const quiet = Date.now() - last;
    if (quiet < silenceMs) return;
    fired = true;
    clearInterval(timer);
    onStall(quiet);
  }, every);
  timer.unref?.();
  return {
    touch() { if (!fired) last = Date.now(); },
    stop() { fired = true; clearInterval(timer); },
  };
}

/**
 * What the director is told when a worker went quiet.
 *
 * Deliberately not just "failed". A stall usually means the endpoint stopped
 * answering rather than that the task was hard, and the one response that is
 * certainly wrong — respawning the identical brief — is exactly what "worker
 * failed" invites.
 */
export function stalledWorkerReport(
  workerId: string, silenceMs: number, partial?: string,
): string {
  const mins = Math.max(1, Math.round(silenceMs / 60_000));
  return (
    `WORKER STALLED: ${workerId} produced no output at all for ${mins} minute(s) and was ` +
    `stopped. It did not fail a task — it never reported anything, which usually means the ` +
    `model endpoint stopped responding rather than that the work was hard.\n\n` +
    `Do NOT immediately respawn an identical worker; if the endpoint is the problem, the ` +
    `next one stalls the same way and the mission spends its budget on silence. Consider ` +
    `instead: doing this piece yourself, splitting it into a smaller brief, or — if workers ` +
    `keep stalling — telling the human via mcp__foreman__ask_human that the worker model ` +
    `appears unreachable.` +
    (partial ? `\n\nPartial output before it went quiet:\n${partial}` : '')
  );
}

/**
 * How many identical tool calls in a row count as a loop.
 *
 * Five, not three: a legitimate retry-with-backoff — a flaky test, a port
 * still bound, a file another process is writing — is two or three attempts,
 * and cutting those off would turn ordinary robustness into a stall report.
 * But the fifth identical call with identical input has no new information
 * in it: nothing the agent controls has changed between attempts, so nothing
 * about the answer will either. Past that point every call is spend with no
 * expected return, and each one resets the silence watchdog, so this is the
 * stall that watchdog can never see.
 */
export const DEFAULT_REPEAT_LIMIT = 5;

/**
 * Tools whose identical repetition is supervision, not a loop.
 *
 * `check_workers` takes no arguments and answers differently each time a
 * worker moves; calling it five times in a row while a worker builds is a
 * director doing its job. The detector fired on exactly that, twenty-seven
 * seconds into the first mixed-provider run — and a second streak would have
 * interrupted a healthy mission for the crime of watching its crew. A status
 * read carries its information in *when* it is made, so sameness of input
 * says nothing; these are exempt, and the charter steers polling toward
 * `wait_for_worker` instead, which blocks until something has changed.
 */
export const REPEAT_EXEMPT: ReadonlySet<string> = new Set([
  'mcp__foreman__check_workers',
  'mcp__foreman__wait_for_worker',
  'mcp__foreman__report_progress',
]);

/** Feed a tool use to a repeat watcher, unless it is one whose repetition is the point. */
export function observeToolUse(
  repeats: { observe(toolName: string, input: unknown): void }, toolName: string, input: unknown,
): void {
  if (REPEAT_EXEMPT.has(toolName)) return;
  repeats.observe(toolName, input);
}

/**
 * JSON with keys sorted at every depth, so two inputs that differ only in
 * key order compare equal. Models emit the same arguments in a different
 * order from one turn to the next often enough that plain JSON.stringify
 * would let a loop hide behind it.
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * Watches for the stall the silence watchdog cannot see: an agent that is
 * busy but looping — the same failing command forty times, the same file
 * re-read forever. It looks like work, burns tokens like work, and keeps the
 * silence clock ticking over like work.
 *
 * Same shape as {@link watchSilence} for the same reason: the rule lives in
 * one small exported function that can be tested without an SDK. The rule is
 * consecutive identity — same tool, deep-equal input — with a different call
 * breaking the streak and re-arming detection. Fires exactly once per streak:
 * the caller decides what to do about it, and a loop that continues past the
 * report is the same loop, not a new finding.
 */
export function watchRepeats(
  limit: number,
  onLoop: (info: { toolName: string; count: number; input: unknown }) => void,
): { observe(toolName: string, input: unknown): void; reset(): void } {
  let key: string | null = null;
  let count = 0;
  let fired = false;
  return {
    observe(toolName, input) {
      const k = `${toolName}\u0000${stableStringify(input)}`;
      if (k === key) {
        count++;
      } else {
        key = k; count = 1; fired = false;
      }
      if (fired || count < limit) return;
      fired = true;
      onLoop({ toolName, count, input });
    },
    reset() { key = null; count = 0; fired = false; },
  };
}

/**
 * What the director is told when a worker was stopped for looping.
 *
 * Parallel to {@link stalledWorkerReport}, and for the same reason: framed as
 * "failed", the natural response is to send the same brief again, and the
 * same brief walks into the same wall. The repeated call is included because
 * it is the one piece of evidence the director cannot otherwise see — it
 * shows where the wall is.
 */
export function loopingWorkerReport(
  workerId: string, toolName: string, count: number, partial?: string,
): string {
  return (
    `WORKER LOOPING: ${workerId} issued the identical ${toolName} call ${count} times in a row ` +
    `with identical input and was stopped. This is a worker stuck, not a task that failed: it ` +
    `hit something it could not see past and kept trying the one move it had.\n\n` +
    `Do NOT respawn the identical brief; a fresh worker with the same instructions finds the ` +
    `same wall. Look at what it was repeating (${toolName}) and either do that step yourself, ` +
    `change the approach or the brief so the step is not needed, or — if the obstacle is ` +
    `outside the mission's control — ask the human via mcp__foreman__ask_human.` +
    (partial ? `\n\nOutput before it was stopped:\n${partial}` : '')
  );
}

/** The tool_use blocks on an SDK assistant message; empty for anything else. */
function toolUsesOf(m: Record<string, unknown>): Array<{ name: string; input: unknown }> {
  if (m.type !== 'assistant') return [];
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is { type: 'tool_use'; name: string; input: unknown } =>
      Boolean(b) && (b as { type?: unknown }).type === 'tool_use' && typeof (b as { name?: unknown }).name === 'string',
  );
}
const DEFAULT_MAX_SECONDS = 4 * 60 * 60;

/**
 * How long wait_for_worker may hold the director's turn.
 *
 * The default is long enough that a director waiting on the one thing it
 * needs is not woken for nothing every few seconds; the hard maximum exists
 * so that no argument the director passes can recreate the blocked-forever
 * turn that synchronous spawning was. A worker that outlives the wait is
 * still running — the director is told so and asked again, and every such
 * return is a turn boundary at which the caps get to bind.
 */
export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 600;

/** How many activity lines a worker record keeps. Enough to see a pattern. */
export const RECENT_LINES = 8;

/**
 * Longest `status` report_progress keeps. One line in a status block that is
 * printed for every worker on every check_workers; a worker that wants to
 * say more has `done`, `next` and `blocked` for it.
 */
export const PROGRESS_STATUS_MAX = 200;

/** The worker-side tool's full name, as the policy and the activity window see it. */
const REPORT_PROGRESS_TOOL = 'mcp__foreman__report_progress';

/**
 * One line of a worker's activity, as the director will see it.
 *
 * A tool name alone says "Bash"; the director needs "Bash npm test" to tell
 * verification from a loop. The hint is the argument that identifies what the
 * call was about — the same handful of keys across the harness's tools — or,
 * failing that, the first string in the input. Kept short because eight of
 * these sit in every check_workers block for every worker.
 */
export function activityHint(toolName: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const keys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description'];
  let arg = keys.map((k) => o[k]).find((v): v is string => typeof v === 'string' && v.length > 0);
  if (arg === undefined) arg = Object.values(o).find((v): v is string => typeof v === 'string' && v.length > 0);
  const hint = arg ? oneLine(arg, 60) : '';
  return hint ? `${toolName} ${hint}` : toolName;
}

/** The head of a piece of text, flattened to one line, cut to `max` chars. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "2m14s" for a duration; what a person reads at a glance. */
function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The compact status block check_workers shows for one worker.
 *
 * Exported for the same reason as the watchdogs: it is the director's only
 * view of a running worker, and what it shows — age, time since the last
 * message, call count, the worker's own progress report, the recent lines,
 * the report once there is one — is a rule worth pinning without an SDK
 * behind it. `withReport` is false when the caller is about to print the
 * report itself.
 *
 * Progress sits above `recent` because it is the better signal: the recent
 * lines are the harness guessing from tool names, the progress block is the
 * worker saying where it is, and a director skimming several blocks should
 * meet the worker's account first.
 */
export function workerStatusBlock(w: WorkerMeta, now = Date.now(), withReport = true): string {
  const head = [`${w.id}  ${w.status}`];
  if (w.startedAt) head.push(`age ${fmtAge((w.endedAt ?? now) - w.startedAt)}`);
  if (w.status === 'running' && w.lastActivityAt) head.push(`last activity ${fmtAge(now - w.lastActivityAt)} ago`);
  head.push(`${w.toolCalls ?? 0} tool calls`);
  const lines = [head.join('  ')];
  if (w.progress) {
    const p = w.progress;
    lines.push(`  progress (${fmtAge(now - p.at)} ago): ${p.status}`);
    if (p.done?.length) lines.push(`    done: ${p.done.join(', ')}`);
    if (p.next) lines.push(`    next: ${p.next}`);
    if (p.blocked) lines.push(`    blocked: ${p.blocked}`);
  }
  if (w.recent?.length) {
    lines.push('  recent:');
    for (const r of w.recent) lines.push(`    ${r}`);
  }
  if (withReport && w.status !== 'running') {
    lines.push(`  report${w.isError ? ' (FAILED)' : ''}:`);
    lines.push(`    ${(w.report || '(no report)').split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}

/** Which half of the crew spent something. Roles can be on different providers. */
type AgentRole = 'director' | 'worker';

/**
 * How a worker may be launched other than as the run configured it. Used by
 * exactly one path — a retry on the director's provider after a stall, at the
 * human's request — so it is deliberately narrow: an environment, a model,
 * and which role's rates price the tokens.
 */
interface WorkerOverrides {
  /** Set on the one continuation a worker gets after the turn cap. */
  continued?: boolean;
  /** The crew preset this worker is, recorded on its meta so a resume can rebuild this. */
  crewPresetId?: string;
  /**
   * Count this agent's dollars as real spend whatever the role it is priced
   * under would normally do. Set for a crew preset on its own priced
   * provider: its bill arrives regardless of how the run's workers are
   * served, and a cap that cannot see it is not a cap.
   */
  nativeCost?: boolean;
  env?: AgentEnv;
  model?: string;
  priceRole?: AgentRole;
  /**
   * Tool rules for THIS worker only, merged over the run's own policy.
   *
   * A reviewer is a worker that must not be able to change what it is
   * judging, and the run's policy cannot say that — it applies to the whole
   * crew, and tightening it for everyone would stop the workers doing the
   * work. So the restriction travels with the one agent it is about; every
   * other worker and the director are built from the run's policy unchanged.
   */
  toolPolicy?: ToolPolicy;
  /** For the transcript and the report: why this worker exists. */
  reason?: string;
}

/** Broadcasts to SSE clients and appends to the run's event log. */
export type Emitter = (event: string, data: unknown) => void;

/** Persists updated run metadata (fire-and-forget from the run's viewpoint). */
export type MetaSink = (meta: RunMeta) => void;

/**
 * Turns a worker gets before the SDK stops it. Raised from 60: five workers
 * in four missions hit the cap mid-task on legitimate, brief-sized work
 * (a hundred TypeScript errors in one package; a test-suite port), and each
 * time the director paid to respawn one that re-read the same files.
 */
const WORKER_MAX_TURNS = 100;

export const DIRECTOR_CHARTER = `
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
   with full context (paths, constraints, expected result). spawn_worker
   RETURNS IMMEDIATELY; the worker runs in the background. Spawn independent
   tasks together so they run in parallel, and never spawn two workers on the
   same files. Supervise with mcp__foreman__check_workers — it shows each
   worker's age, recent activity and finished report — rather than waiting
   blind. Do not poll check_workers in a tight loop — each call is a turn you
   pay for and it will not change faster than the worker does; to wait for a
   result, call mcp__foreman__wait_for_worker, which blocks until something
   has changed (it is bounded, and tells you if the worker is still going).
   Use mcp__foreman__message_worker to send follow-ups or corrections to a
   finished worker. You may read files and run verification commands yourself,
   but implementation edits belong to workers. A worker's report is a claim to
   verify, not a fact.
   A WORKER THAT STALLS IS NOT A WORKER THAT FAILED. If a worker's report says
   it produced nothing and was stopped, the endpoint serving it is
   the likely cause, not the task. Respawning the same brief is then the one
   response guaranteed to waste the same minutes again. Do the piece yourself,
   or cut it into a smaller brief, and if a second worker stalls the same way
   say so to the human via mcp__foreman__ask_human rather than continuing to
   spend the run on silence. Record it in the log either way: a mission that
   quietly lost half an hour to a dead endpoint should say so.
   A WORKER THAT LOOPS IS THE SAME CASE. If a worker's report says it
   repeated one call many times and was stopped, it hit a wall it could not
   see. Do not send the same brief back; look at what it was repeating, and
   change the approach or the brief.
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
   WORK INSIDE THE WORKSPACE. Everything you or a worker creates —
   verification scripts, screenshots, scratch tooling, node_modules for a
   helper, temp output — goes under ${WORK_DIR}/ inside the mission folder,
   never /tmp or anywhere outside it. It is gitignored, so it keeps the
   project root clean without leaving the project. A write to /tmp or any
   other temp directory is DENIED outright, no question asked — the denial
   names ${WORK_DIR}/ and you redo it there. Any other path outside the folder
   asks the human, and an ask nobody answers within ${DEFAULT_ASK_TIMEOUT_MS / 60_000}
   minutes is denied the same way; a mission that needs the outside should
   say so in MISSION.md and ask via mcp__foreman__ask_human, not discover it
   mid-run. If you are prompted for a path outside the folder, the answer is
   almost always to redo it under ${WORK_DIR}/, not to wait for approval.
   SHOW, DON'T DESCRIBE: when you have a server running that shows the work
   (a dev server, a static preview), call mcp__foreman__expose_service with
   its port and put the URL it returns in your report — the human can open
   it from their phone. Keep that server up until the mission ends.
   CLEAN UP WHAT YOU STARTED: before you finish, stop every server, watcher or
   background process the crew started that you are not deliberately leaving
   for the human, and name in your report any you left up and on which port.
   A process that outlives the mission holds its port until somebody hunts it
   down by hand.
   SIZE THE TASK TO THE WORKER: a worker is stopped after ${WORKER_MAX_TURNS}
   turns of its own. It gets one continuation to finish what it was doing, and
   after that the task comes back to you half-done. So give a worker a task it
   can finish in that many steps — split the big ones — rather than one brief
   that has to be rescued twice.
4. GET THE REVIEW LAST. If this run has a crew reviewer marked required, call
   mcp__foreman__request_review with its preset id AFTER your final change and
   before you tick the last box. It reads the diff and answers PASS or FAIL;
   Foreman will not record the run as done without that PASS, and a change made
   after a PASS makes it stale — the reviewer would have passed code that no
   longer exists — so review last, then stop.
5. REPORT WHAT YOU SEE. Judge the work as a competent professional would, not
   only against the letter of the acceptance criteria. If you observe a defect
   the criteria did not name — tap targets too small to use, unreadable
   contrast, a broken layout, a hazard, an obviously wrong result — fix it
   when it is clearly in scope, and otherwise say so plainly in your final
   summary and in MISSION.md. Staying silent about a problem you could see is
   a failed mission even when every listed box is ticked.
6. DECIDE AND RECORD, DON'T ASK. You are running unattended more often than
   not. Make the reasonable call, write it and the reasoning into MISSION.md,
   and continue. Reserve mcp__foreman__ask_human for decisions that are
   irreversible or that spend money the mission was not given — those you ask
   and wait for. A question left unanswered for ${DEFAULT_ASK_TIMEOUT_MS / 60_000}
   minutes is auto-answered "decide yourself"; treat that answer as the
   human's, record what you decided, and do not ask it again.
7. NEVER modify Foreman itself, its server, or any oversight tooling. Tooling
   failure is an escalation, never a self-repair.
8. When DONE WHEN is verified, update MISSION.md (all boxes ticked, final log
   entry) and end with a short summary of what was built and how you verified it.
9. LEAVE NOTES FOR THE NEXT CREW. Before you finish, call mcp__foreman__remember
   with the whole project memory as it should read now: how to run and test
   the project, ports and paths that matter, conventions and the reasons
   behind them, traps you fell into. Facts, one line each, a page at most.
   Rewrite stale lines rather than appending; drop what no longer holds.
   Never a secret, never anything outside this project.
`;

export const WORKER_CHARTER = `
You are a FOREMAN WORKER. Complete exactly the task you were given, inside the
working directory. Never ask interactive questions — if you are blocked on a
decision you cannot make, print "BLOCKED: <your question>" and end your turn.
REPORT PROGRESS. Call mcp__foreman__report_progress when you finish a distinct
sub-step, when you change approach, and immediately when you are blocked. The
director supervises several workers and can only help with what it can see; a
worker that goes quiet for minutes looks stalled and may be stopped. Reporting
is never a substitute for finishing.
WORK INSIDE THE WORKSPACE. Anything you create that is not part of the task's
deliverable — scripts, screenshots, helper installs, temp output — goes under
${WORK_DIR}/ inside the working directory, never /tmp or anywhere outside it.
A write to /tmp or another temp directory is denied outright; any other path
outside the folder asks the human and is denied if nobody answers within
${DEFAULT_ASK_TIMEOUT_MS / 60_000} minutes. Either way, redo it under ${WORK_DIR}/
instead of waiting.
When finished, end with a concise report of what you did and how you checked it.
`;

/** Foreman's bundled Playwright MCP server, resolved from this repo. */

/** Claude subscription/quota exhaustion — an external pause, not a failure. */
const USAGE_LIMIT_RE = /out of usage credits|usage limit reached|upgrade to increase your usage/i;

/** One worker's outcome, as runWorker hands it back. */
interface WorkerOutcome { report: string; isError: boolean }

/** What a worker stopped by the cap is told when its session is picked back up. */
const WORKER_CONTINUE_PROMPT =
  'You were stopped by the turn cap, not by a failure. Your session and your files are as you left them; ' +
  '`git status` and `git diff` show your uncommitted work. Continue the same task from where you were — do not ' +
  'start over or re-read what you already know — finish it, report with report_progress, and end your turn.';

/**
 * A worker record plus the in-process handles that must never be persisted:
 * the live query (for interrupts), the run promise (so nothing is left
 * floating), and the `done` promise wait_for_worker races against a timer.
 * Everything here is stripped by syncWorkersMeta().
 */
interface WorkerRuntime extends WorkerMeta {
  q?: Query;
  /**
   * The overrides this worker was launched with, kept so a follow-up message
   * resumes the same agent rather than an ordinary worker wearing its id — a
   * reviewer's read-only policy, model and provider must outlive its first
   * turn.
   */
  overrides?: WorkerOverrides;
  promise?: Promise<WorkerOutcome>;
  done?: Promise<void>;
  settle?: () => void;
  /** The report has been returned to the director at least once. Never deletes it. */
  reportShown?: boolean;
}

const RUNTIME_ONLY: ReadonlyArray<keyof WorkerRuntime> = ['q', 'promise', 'done', 'settle', 'reportShown', 'overrides'];

export class MissionRun {
  readonly meta: RunMeta;
  private directorQ?: Query;
  private readonly workers = new Map<string, WorkerRuntime>();
  private workerSeq = 0;
  private readonly runAllowed = new Set<string>();
  /**
   * Directories the human opened with "always" on a folder-boundary card.
   * Consulted by the policy on every call, so a grant covers the very next
   * sibling command — which is the loop it exists to break.
   */
  private readonly allowedRoots = new Set<string>();
  /** Set once the cap is passed; the wind-down turn is allowed, then the loop ends. */
  private budgetStopped = false;
  private readonly pendingPermissions = new Map<string, PendingPermission & { agent: string }>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  /**
   * What each pending ask *is*, for surfaces that answer it away from the
   * transcript — the fleet board, a phone. The resolvers above know only how
   * to settle an ask; this is the text, the options and when it was raised.
   */
  private readonly askMeta = new Map<string, {
    kind: 'permission' | 'question'; text: string; options?: string[]; toolName?: string; since: number;
  }>();
  /**
   * The unattended-default timer per pending ask (permission or question),
   * keyed by the ask's id. Cancelled on any normal resolution and swept in
   * the run's `finally`, so a timer never fires into a run that is over.
   */
  private readonly askTimers = new Map<string, { cancel(): void }>();
  /** The director's streaming prompt; steering pushes into it. */
  private directorInput?: MessageStream;
  /** The project's notes as a worker-prompt section, read once per start; empty when there are none. */
  private memoryForWorkers = '';
  /** Director cost is cumulative per query; track the last figure for deltas. */
  private directorCostSeen = 0;
  private wasInterrupted = false;
  private usageLimited = false;
  /** Director turns taken, for the cap that applies to every provider. */
  private turns = 0;
  /** Gateway tokens seen since the last confirmed result. Never persisted. */
  private interimUsage: TokenUsage = emptyUsage();
  /** The ledger reading the interim is measured against. */
  private ledgerBaseline: (TokenUsage & { calls: number; costUsd?: number }) | null = null;
  /** The three piles `meta.costUsd` is the sum of — see RunMeta.costParts. */
  private costParts: { native: number; rated: number; ledger: number };
  /** Ledger cost persisted by earlier attempts; this attempt's ledger starts at zero. */
  private ledgerBefore = 0;
  /** Once an upstream has stated a cost, its figure outranks the rated one for gateway tokens. */
  private ledgerReportsCost = false;
  private rebaseline = false;
  private ledgerTimer?: ReturnType<typeof setInterval>;
  private capTimer?: ReturnType<typeof setInterval>;
  private hardStopped = false;
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
     *
     * `crew` is the same thing for a crew preset that named a provider of its
     * own, keyed by preset id, and it is deliberately partial: a preset with no
     * `providerId`, or one whose provider no longer resolves, simply has no
     * entry and runs on the worker env. Optional on the argument rather than a
     * parameter of its own so every existing call site — and every test that
     * constructs a run with two roles — keeps working untouched.
     */
    private readonly agentEnv: { director: AgentEnv; worker: AgentEnv; crew?: Record<string, AgentEnv> },
    /**
     * Per-token rates per role, where the endpoint that will send the bill
     * published them (see prices.ts). Absent for an Anthropic-native role —
     * the SDK already reports its real cost — and absent for any endpoint that
     * publishes nothing, which is what keeps that run honestly `unpriced`
     * rather than priced from a table Foreman made up.
     */
    private readonly prices: { director?: ModelPrice; worker?: ModelPrice } = {},
    /**
     * Live token counts from the gateway, for the long stretches where the
     * SDK has nothing to say.
     *
     * An OpenAI-compatible endpoint reports usage only on the final chunk of
     * a stream, and the SDK only surfaces it on the `result` message that
     * ends a turn — so a director working through one long turn shows zero
     * tokens for minutes while really having spent a hundred thousand. The
     * gateway sees every response, so it can answer in the meantime.
     *
     * Strictly an INTERIM figure: it is emitted, never persisted, and it is
     * reset to nothing every time a `result` message arrives with the real
     * number. The SDK stays the authority on what this run actually spent.
     */
    private readonly ledger?: {
      key: string;
      roles: { director: boolean; worker: boolean };
      read: (key: string) => Promise<TokenUsage & { calls: number; costUsd?: number } | null>;
    },
    /**
     * Each role's cost basis, so a mid-run change of provider — a worker
     * retried on the director's — can re-derive the run's basis and say so
     * before another token is spent. Absent means "unknown", which leaves the
     * run's basis alone.
     */
    private readonly roleBasis?: {
      director: CostBasis; worker: CostBasis;
      /**
       * A crew preset that runs on a provider of its own, by preset id. Its
       * review is not free just because the run's workers are: a paid
       * reviewer beside a free gateway worker had its dollars dropped, because
       * cost was attributed to the worker role and that role's figures are
       * discarded. What a provider will bill is decided by the provider, so
       * the preset's own basis is what counts its spend and what folds into
       * the run's.
       */
      crew?: Record<string, CostBasis>;
    },
    /**
     * What the host lends the run beyond the model: today, putting a dev
     * server the crew started behind Foreman's own address so the human can
     * open it from the phone. Optional — a run without a host hook simply
     * has no `expose_service` to offer.
     */
    private readonly host: {
      exposeService?: (runId: string, port: number, label: string) => Promise<{ ok: true; url: string; path: string; pid?: number } | { ok: false; reason: string }>;
      /** The browser channel detected at dispatch (src/browser.ts); Chrome when the host says nothing. */
      browserChannel?: string;
    } = {},
  ) {
    this.meta = meta;
    // Cost kept as parts, so a resume adds to the right pile and an upstream
    // that reports its own figure can outrank the rated one for the same
    // tokens. A run recorded before parts existed has its whole total treated
    // as native, which changes nothing about what it shows.
    this.costParts = meta.costParts ?? { native: meta.costUsd ?? 0, rated: 0, ledger: 0 };
    this.ledgerBefore = this.costParts.ledger;
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
      const r: WorkerRuntime = { ...w };
      // A worker persisted as 'running' has no process behind it any more: the
      // one that was driving it died with the previous Foreman. Left as
      // 'running', wait_for_worker would have nothing to wait on and
      // check_workers would show a worker that is never going to finish.
      // Its session may still be resumable, and the record says so.
      if (r.status === 'running') {
        r.status = 'error';
        r.isError = true;
        r.endedAt = r.endedAt ?? Date.now();
        r.report = r.report ?? 'Foreman restarted while this worker was running; its result was lost. ' +
          'Verify what it left on disk, then message_worker it to continue or spawn a fresh one.';
      }
      this.workers.set(w.id, r);
      const n = Number(w.id.match(/^worker-(\d+)$/)?.[1] ?? 0);
      if (n > this.workerSeq) this.workerSeq = n;
    }
    for (const t of meta.allowedTools ?? []) this.runAllowed.add(t);
    for (const r of meta.allowedRoots ?? []) this.allowedRoots.add(r);
  }

  /** Writes both grant sets back to meta and persists — one place, so they cannot drift. */
  private syncAllowed(): void {
    this.meta.allowedTools = [...this.runAllowed];
    this.meta.allowedRoots = [...this.allowedRoots];
    this.saveMeta(this.meta);
  }

  // -- unattended defaults ----------------------------------------------------

  /**
   * Arms the unattended-default timer for one ask. `onTimeout` runs only if
   * the ask is still pending when the clock expires; it receives the wait so
   * the message and the event can say how long the human was given.
   */
  private armAsk(id: string, onTimeout: (afterMs: number) => void): void {
    const ms = this.meta.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.askTimers.set(id, armAskTimeout(ms, () => {
      this.askTimers.delete(id);
      onTimeout(ms);
    }));
  }

  private cancelAsk(id: string): void {
    this.askTimers.get(id)?.cancel();
    this.askTimers.delete(id);
  }

  private cancelAllAsks(): void {
    for (const t of this.askTimers.values()) t.cancel();
    this.askTimers.clear();
  }

  // -- public control surface (called by the HTTP layer) --------------------

  get pendingPermissionIds(): string[] {
    return [...this.pendingPermissions.keys()];
  }

  get pendingQuestionIds(): string[] {
    return [...this.pendingQuestions.keys()];
  }

  /** Every ask still open, with the text and options a remote surface needs to answer it. */
  pendingAsks(): Array<{ id: string; kind: 'permission' | 'question'; text: string; options?: string[]; toolName?: string; since: number }> {
    return [...this.askMeta].map(([id, m]) => ({ id, ...m }));
  }

  resolvePermission(id: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): boolean {
    this.askMeta.delete(id);
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;
    this.pendingPermissions.delete(id);
    this.cancelAsk(id);
    let result: PermissionResult;
    if (decision === 'allow_always' && pending.escapedPath) {
      // The card was about a PATH, so that is what "always" grants — see the
      // contract on `PendingPermission.escapedPath`. Adding the tool instead
      // would be ignored by the boundary (by design) and the next sibling
      // command would prompt again: "Always" looked broken while doing
      // exactly what it said. Not `updatedPermissions`: the SDK's grant is a
      // tool rule, and there is none to give here.
      this.allowedRoots.add(pending.escapedPath);
      this.syncAllowed();
      this.emit('root_allowed', { path: pending.escapedPath, agent: pending.agent, toolName: pending.toolName });
      result = { behavior: 'allow' };
    } else if (decision === 'allow_always') {
      this.runAllowed.add(pending.toolName);
      this.syncAllowed();
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
    this.askMeta.delete(id);
    const resolve = this.pendingQuestions.get(id);
    if (!resolve) return false;
    this.pendingQuestions.delete(id);
    this.cancelAsk(id);
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

  /**
   * Change a running mission's settings without restarting it.
   *
   * Both fields genuinely bind mid-run, which is why these two and not a
   * general settings patch:
   *
   *  - **`browserTools`** is read by browserServers() at every worker spawn,
   *    so turning it on reaches every worker started from now on. The
   *    director keeps whatever tool set its own query() was opened with and
   *    gains the browser on its next resume — said plainly in the returned
   *    note, because a half-applied change the human believes is fully
   *    applied is worse than one they know the shape of.
   *  - **`budgetUsd`** is re-read by enforceBudget() on every cost update, so
   *    a raised cap takes effect on the next token. Raising it also clears the
   *    alerts already sent: a notice that fired against the old figure has
   *    been superseded, and leaving the flags set would mean a genuine
   *    overrun of the NEW budget passed in silence.
   *
   * Returns what actually changed, for the transcript. A governance layer has
   * to record who changed the rules mid-mission, so this is emitted into the
   * run's own event log rather than only mutating state.
   */
  applySettings(patch: { browserTools?: boolean; budgetUsd?: number }): string[] {
    const changed: string[] = [];

    if (typeof patch.browserTools === 'boolean' && patch.browserTools !== Boolean(this.meta.browserTools)) {
      this.meta.browserTools = patch.browserTools || undefined;
      changed.push(patch.browserTools
        ? 'browser tools ON — workers spawned from now on get a headless browser; ' +
          'the director gains it when the run is resumed'
        : 'browser tools OFF — no worker spawned from now on gets a browser');
    }

    if (typeof patch.budgetUsd === 'number' && Number.isFinite(patch.budgetUsd)
        && patch.budgetUsd >= 0 && patch.budgetUsd !== this.meta.budgetUsd) {
      const raised = patch.budgetUsd > this.meta.budgetUsd;
      changed.push(`budget $${this.meta.budgetUsd.toFixed(2)} → $${patch.budgetUsd.toFixed(2)}`);
      this.meta.budgetUsd = patch.budgetUsd;
      if (raised) {
        // The wind-down order already delivered cannot be unsaid — the
        // director read it — but the flags must not keep a later, real
        // overrun quiet.
        this.budgetNoticeSent = false;
        this.budgetKillSent = false;
        this.budgetWarnSent = false;
        this.budgetStopped = false;
      }
    }

    if (changed.length) {
      this.saveMeta(this.meta);
      this.emit('settings_changed', { changes: changed, browserTools: Boolean(this.meta.browserTools), budgetUsd: this.meta.budgetUsd });
      this.emitEconomics();
    }
    return changed;
  }

  async interrupt(): Promise<void> {
    this.wasInterrupted = true;
    // Pending asks are settled by the SDK's abort (permissions) or die with
    // the query (questions); a timer firing after that would auto-deny into
    // a run that is already stopping and stamp the transcript with a wait
    // that was never going to be answered.
    this.cancelAllAsks();
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
    // Only a run with a gatewayed role has anything to poll for. Three
    // seconds is chosen against what it is for — a person watching a turn
    // that has been silent for minutes — not against how fast tokens move.
    if (this.ledger && (this.ledger.roles.director || this.ledger.roles.worker)) {
      this.ledgerTimer = setInterval(() => void this.pollLedger(), 3000);
      this.ledgerTimer.unref?.();
    }
    // The backstop for the caps the director cannot check while it is blocked
    // inside a tool call. Deliberately later than the graceful wind-down, so
    // a responsive director always gets to finish its own way.
    this.capTimer = setInterval(() => this.enforceCapsFromOutside(), 60_000);
    this.capTimer.unref?.();
    this.emit(isResume ? 'run_resumed' : 'run_started', {
      runId: this.meta.id,
      folder: this.meta.folder,
      mission: this.meta.mission,
      budgetUsd: this.meta.budgetUsd,
      costUsd: this.meta.costUsd,
      // Carried here, not only on `cost`, because a run that spends no
      // priceable dollars may never emit a cost event at all — and the UI
      // would then keep replaying an older run's cost basis forever.
      costBasis: costBasisOf(this.meta),
      metered: isPriced(this.meta),
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
        this.gitLine() +
        this.crewLine() +
        this.budgetNote() +
        memorySection((await readMemory(this.meta.folder)).text, 'director')
      : `MISSION: ${this.meta.mission}\n\n${this.budgetLine()} ` +
        `Working directory: ${this.meta.folder}. ${this.gitLine()}Begin by writing .foreman/MISSION.md, then execute the plan.` +
        this.crewLine() +
        memorySection((await readMemory(this.meta.folder)).text, 'director');

    try {
      // The mission doc directory ignores itself wholesale (`*`, which also
      // covers the scratch space) so missions never pollute `git status` in
      // real repositories — MISSION.md is Foreman's record, not the project's.
      // Ensured rather than overwritten, so a rule someone added by hand
      // survives. The scratch space exists before the director's first turn,
      // fresh start and resume alike (a resumed folder may predate WORK_DIR).
      // The first mkdir is inside the try so a bad folder surfaces as a failed
      // run, never an unhandled rejection; the scratch dir swallows its own
      // errors because a missing outlet should not stop a mission, only make
      // it ask more.
      const foremanDir = path.join(this.meta.folder, '.foreman');
      await mkdir(foremanDir, { recursive: true });
      await ensureIgnoreLines(path.join(foremanDir, '.gitignore'), ['*']);
      // What the folder looks like before the crew touches it, so the deck
      // can later say what this run changed. Fresh starts only: a resume
      // continues the same run and must keep the same baseline. Never on the
      // critical path — a missing baseline degrades to "cannot attribute",
      // not to a failed run.
      if (!isResume) {
        void captureBaseline(this.meta.folder, this.meta.id).catch(() => {});
      }
      await mkdir(path.join(this.meta.folder, WORK_DIR), { recursive: true }).catch(() => {});
      this.memoryForWorkers = memorySection((await readMemory(this.meta.folder)).text, 'worker');
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

      // The loop watchdog for the director. Not a kill: the director has the
      // mission context and is the only agent that can change course, so the
      // first streak gets an in-band notice. A second streak of the same call
      // after being told, in so many words, that it is looping is a director
      // that is not going to recover — and every further turn is spend. Built
      // fresh per query() call, so a resumed session starts with a clean slate
      // rather than inheriting a streak from a context it no longer has.
      let loopNoticed: string | null = null;
      const repeats = watchRepeats(DEFAULT_REPEAT_LIMIT, ({ toolName, count, input }) => {
        const streak = `${toolName}\u0000${stableStringify(input)}`;
        this.emit('director_looping', { toolName, count });
        if (loopNoticed === streak) {
          this.emit('run_error', {
            error: `Director ignored a loop notice and issued the identical ${toolName} call ` +
              `${count} more times in a row — run interrupted.`,
          });
          void this.interrupt();
          return;
        }
        loopNoticed = streak;
        repeats.reset();
        this.directorInput?.push(
          '[LOOP DETECTED — automated notice]\n' +
          `You have issued the identical ${toolName} call ${count} times in a row with identical ` +
          'input. Repeating it again will not produce a different result. Stop, state in one ' +
          'sentence what you expected to change and why it did not, and either take a different ' +
          'approach or ask the human via mcp__foreman__ask_human.',
        );
      });

      let lastTurnFailed = false;
      for await (const msg of this.directorQ as AsyncIterable<SDKMessage>) {
        const m = msg as Record<string, unknown>;
        if (typeof m.session_id === 'string') this.meta.directorSessionId = m.session_id;
        for (const t of toolUsesOf(m)) observeToolUse(repeats, t.name, t.input);
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
      // Stop polling before anything else: the run is over, every result is
      // in, and an interim estimate outliving the real figure would be the
      // one number here that is not backed by anything.
      if (this.ledgerTimer) clearInterval(this.ledgerTimer);
      if (this.capTimer) clearInterval(this.capTimer);
      this.cancelAllAsks();
      this.interimUsage = emptyUsage();
      // "Always allow" makes the SDK write .claude/settings.local.json into the
      // mission folder, which appears only once a grant happens — so this runs
      // after the work, not just before it.
      await this.ignoreLocalSettings();
      if (this.meta.status === 'running') this.meta.status = 'interrupted';

      await this.settleFinalStatus();
      this.meta.endedAt = Date.now();
      this.saveMeta(this.meta);
      this.emit('run_finished', {
        status: this.meta.status,
        costUsd: this.meta.costUsd,
        directorSessionId: this.meta.directorSessionId,
      });
    }
  }

  /**
   * The last word on whether this run counts as done — the two records that
   * outrank the director's own exit, applied in one place.
   *
   * A director's exit is not proof its mission succeeded. The charter makes
   * it write DONE WHEN criteria and tick each one the moment it is actually
   * verified, so criteria still unticked at exit are the director's own
   * record that the work is unfinished — and reporting that as 'done' is
   * the one lie a mission runner cannot afford. Downgrading to
   * 'interrupted' is also the useful answer: it is what makes the run
   * resumable rather than closed.
   * A mission whose own record says every criterion is verified is done,
   * even if the cap ended the turn it was writing its report in. Calling
   * that 'interrupted' told the fleet a finished mission had failed, and
   * invited a resume that spent more to rewrite a report already on disk.
   * The stop reason stays on the record, so nothing is hidden.
   *
   * Separated from `start`'s `finally` because it is the rule, not the
   * teardown: a test can drive it on a run whose status and crew are set by
   * hand, which is the only way the gate below is provable without an SDK.
   */
  private async settleFinalStatus(): Promise<void> {
    // The reviewer gate, computed once for the whole method: whether every
    // reviewer the human marked required has passed the diff this run
    // actually ends with. Null means nothing is outstanding — either no
    // required reviewer, or all of them passed the current diff. It gates
    // both routes to 'done' below, because a run that reached its cap with
    // every box ticked is in exactly the position the gate exists for: the
    // director says it is finished and nobody else has looked.
    const gate = await this.reviewGate();
    if (this.meta.status === 'interrupted' && this.budgetStopped
        && !this.wasInterrupted && !this.usageLimited) {
      const unmet = await this.unmetCriteria();
      if (doneAtCap({ budgetStopped: this.budgetStopped, wasInterrupted: this.wasInterrupted, usageLimited: this.usageLimited }, unmet)) {
        if (gate) {
          // Ticked every box and ran out of budget, but the reviewer the
          // human required never passed this diff: the run stays interrupted
          // and resumable, and the event says which reviewer and why.
          this.emit('mission_unreviewed', { blockers: gate.blockers, text: gate.text });
        } else {
          this.meta.status = 'done';
          this.emit('mission_done_at_cap', {
            costUsd: this.meta.costUsd, budgetUsd: this.meta.budgetUsd, reason: this.meta.stopReason,
            text: 'Every DONE WHEN criterion was verified before the cap ended the run, so this mission is done. ' +
              'It stopped at its limit rather than finishing under it — the report may be shorter than usual.',
          });
        }
      }
    }
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
      } else if (gate) {
        // Every box ticked and the director says it is finished — and the
        // reviewer the human required has not passed the diff it ends with.
        // Foreman refuses the label rather than asking the director to.
        this.meta.status = 'interrupted';
        this.emit('mission_unreviewed', { blockers: gate.blockers, text: gate.text });
      }
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
    const doc = await this.missionDoc();
    const section = doc === null ? null : doneWhenSection(doc);
    if (section === null) return null;

    const unmet: string[] = [];
    let sawAny = false;
    for (const line of section) {
      const box = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/);
      if (!box) continue;
      sawAny = true;
      if (box[1] === ' ') unmet.push(box[2].trim());
    }
    return sawAny ? unmet : null;
  }

  /** The mission doc as text, or null when the director never wrote one. */
  private missionDoc(): Promise<string | null> {
    return readFile(path.join(this.meta.folder, '.foreman', 'MISSION.md'), 'utf8').catch(() => null);
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
        // The channel the server detected for this machine: FOREMAN_BROWSER,
        // else its Chrome, else Playwright's own Chromium (src/browser.ts).
        args: [PLAYWRIGHT_MCP_CLI, '--headless', '--isolated', '--browser', this.host.browserChannel ?? process.env.FOREMAN_BROWSER ?? 'chrome'],
      },
    };
  }

  /**
   * The permission callback for one agent. `override` tightens (or loosens)
   * the run's tool policy for that agent alone — see
   * {@link WorkerOverrides.toolPolicy}. Merged OVER the run's policy rather
   * than replacing it, so a reviewer still inherits everything the run
   * decided and only differs where the preset says it must.
   */
  private policyFor(agent: string, override?: ToolPolicy) {
    return makePolicy(agent, this.meta.folder, this.runAllowed, this.allowedRoots, {
      onAutoAllow: (a, toolName, reason) => this.emit('auto_allowed', { agent: a, toolName, reason }),
      onAutoDeny: (a, toolName, reason) => this.emit('auto_denied', { agent: a, toolName, reason }),
      onAsk: (a, id, req) => {
        this.askMeta.set(id, {
          kind: 'permission', toolName: req.toolName, since: Date.now(),
          text: `${a} wants ${req.toolName}${req.description ? ` — ${req.description}` : ''}`,
        });
        this.emit('permission_request', { id, agent: a, ...req });
      },
      register: (id, pending) => {
        // `pending` carries `escapedPath` through untouched: resolvePermission
        // reads it to decide whether "always" grants the path or the tool.
        this.pendingPermissions.set(id, { ...pending, agent });
        // The unattended default. Resolved here rather than through
        // resolvePermission so the transcript gets `permission_timeout`, not
        // a `permission_resolved` that looks like a human clicked Deny.
        this.armAsk(id, (afterMs) => {
          if (!this.pendingPermissions.delete(id)) return;
          pending.resolve({ behavior: 'deny', message: unattendedDenyMessage(afterMs) });
          this.emit('permission_timeout', { id, agent, toolName: pending.toolName, afterMs });
        });
      },
      unregister: (id) => {
        this.askMeta.delete(id);
        const existed = this.pendingPermissions.delete(id);
        this.cancelAsk(id);
        if (existed) this.emit('permission_resolved', { id, behavior: 'aborted' });
        return existed;
      },
    }, {
      toolPolicy: override ? { ...this.meta.toolPolicy, ...override } : this.meta.toolPolicy,
      autoAllowReadOnly: this.meta.autoAllowReadOnly,
    });
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
  private budgetWarnSent = false;

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
    await ensureIgnoreLines(path.join(dir, '.gitignore'), LOCAL_IGNORE_LINES);
  }


  /**
   * `costUsd` from its parts. The upstream's own figure, once it has given
   * one, replaces the rated figure for gateway tokens rather than adding to
   * it — they price the same tokens, and the party that sends the bill wins.
   */
  private recomputeCost(): void {
    const p = this.costParts;
    this.meta.costUsd = p.native + (this.ledgerReportsCost ? p.ledger : p.rated);
    this.meta.costParts = { ...p };
  }

  private addCost(usd: number | undefined, role: AgentRole = 'director', native = false): void {
    if (typeof usd !== 'number') return;
    // `native` is for an agent that runs somewhere else entirely — a crew
    // preset on its own priced provider — where the role's treatment is the
    // wrong answer and the SDK's dollars are a fact about this run.
    if (native) {
      this.costParts.native += usd;
      this.recomputeCost();
      this.saveMeta(this.meta);
      this.emitEconomics();
      this.enforceBudget();
      return;
    }
    // Two cases where the SDK's dollar figure is not a fact about this run:
    // a role Foreman prices itself, and a role behind a gateway at all. The
    // second is the one that leaked — Anthropic's table applied to 5.8M
    // Ollama tokens produced "$30.14" on a fleet card for a run that cost
    // nothing measurable. Stopped at the source, not hidden at the display.
    if (this.prices[role] || this.ledger?.roles[role]) return;
    this.costParts.native += usd;
    this.recomputeCost();
    this.saveMeta(this.meta);
    this.emitEconomics();
    this.enforceBudget();
  }

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
      usage: this.liveUsage(),
      costBasis: costBasisOf(this.meta),
      metered: isPriced(this.meta),
      turns: this.turns,
    });
  }

  /**
   * Read the gateway's running total and republish the economics.
   *
   * The baseline is what the ledger held at the last confirmed result, so
   * what is shown is only the growth since — added to a persisted total that
   * already accounts for everything before it. When a result lands, the
   * interim is dropped to nothing rather than carried, because briefly
   * under-reporting an estimate is safer than briefly double-counting one.
   */
  private async pollLedger(): Promise<void> {
    if (!this.ledger) return;
    const now = await this.ledger.read(this.ledger.key).catch(() => null);
    if (!now) return;
    // An upstream that states its own cost per response (OpenRouter does) is
    // the most authoritative figure there is for those tokens: it replaces
    // the rated figure rather than adding to it. A run that was `unpriced`
    // becomes `priced` the moment a real bill shows up — and says so, because
    // the dollar cap arms with it.
    if (typeof now.costUsd === 'number' && Number.isFinite(now.costUsd)) {
      const before = this.meta.costUsd;
      this.ledgerReportsCost = true;
      this.costParts.ledger = this.ledgerBefore + now.costUsd;
      if (!isPriced(this.meta)) {
        this.meta.costBasis = 'priced';
        this.meta.metered = true;
        this.emit('settings_changed', {
          changes: ['the upstream reports its own cost per response — this run is now priced and the dollar cap is live'],
          browserTools: Boolean(this.meta.browserTools), budgetUsd: this.meta.budgetUsd,
        });
      }
      this.recomputeCost();
      if (this.meta.costUsd !== before) { this.saveMeta(this.meta); this.enforceBudget(); }
    }
    if (!this.ledgerBaseline || this.rebaseline) {
      this.ledgerBaseline = now;
      this.rebaseline = false;
      return;
    }
    const b = this.ledgerBaseline;
    const grew = {
      inputTokens: Math.max(0, now.inputTokens - b.inputTokens),
      outputTokens: Math.max(0, now.outputTokens - b.outputTokens),
      cacheReadTokens: Math.max(0, now.cacheReadTokens - b.cacheReadTokens),
      cacheWriteTokens: Math.max(0, now.cacheWriteTokens - b.cacheWriteTokens),
    };
    const changed = Object.keys(grew).some(
      (k) => grew[k as keyof TokenUsage] !== this.interimUsage[k as keyof TokenUsage],
    );
    this.interimUsage = grew;
    if (changed) this.emitEconomics();
  }

  /** Confirmed usage plus whatever the gateway has seen since. */
  private liveUsage(): TokenUsage {
    const c = this.meta.usage ?? emptyUsage();
    const i = this.interimUsage;
    return {
      inputTokens: c.inputTokens + i.inputTokens,
      outputTokens: c.outputTokens + i.outputTokens,
      cacheReadTokens: c.cacheReadTokens + i.cacheReadTokens,
      cacheWriteTokens: c.cacheWriteTokens + i.cacheWriteTokens,
    };
  }

  private addUsage(raw: unknown, role: AgentRole = 'director'): void {
    // The real number for this turn just arrived; the estimate standing in
    // for it is now redundant, and the ledger must be re-baselined so the
    // same tokens are not offered again as growth.
    this.interimUsage = emptyUsage();
    this.rebaseline = true;
    const delta = normalizeUsage(raw);
    this.meta.usage = accumulateUsage(this.meta.usage ?? emptyUsage(), raw);
    this.meta.turns = this.turns;
    // Where the endpoint published rates, this is the run's real cost: its
    // own tokens at its own prices, accumulated per role so a mixed run bills
    // each half correctly instead of applying one table to both.
    const price = this.prices[role];
    if (price) { this.costParts.rated += priceUsage(price, delta); this.recomputeCost(); }
    this.saveMeta(this.meta);
    this.emitEconomics();
    if (price) this.enforceBudget();
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
    // fire on a figure that is not real money. A run that is not `priced` is
    // bounded by the turn and time caps in capReached() instead.
    if (!isPriced(this.meta)) return;
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
    // Before the fence, a nudge. A director that only learns of the cap when
    // it hits it does its verification and its report inside the one turn it
    // has left — which is how two missions that had finished their work were
    // cut mid-report and read as failures. Warn while there is still room to
    // wind down deliberately.
    if (!this.budgetWarnSent && budgetWarnDue(costUsd, budgetUsd, this.meta.budgetWarnAt)) {
      this.budgetWarnSent = true;
      const pct = Math.round((costUsd / budgetUsd) * 100);
      this.emit('budget_alert', {
        level: 'warn', costUsd, budgetUsd,
        text: `${pct}% of the budget spent ($${costUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}) — director told to start verifying.`,
      });
      this.directorInput?.push(
        '[BUDGET — automated notice]\n' +
        `You have spent $${costUsd.toFixed(2)} of the $${budgetUsd.toFixed(2)} cap (${pct}%). ` +
        'Start winding down now: finish or stop the work in flight, do not begin anything you ' +
        'cannot complete and verify within what is left, and get your verification and MISSION.md ' +
        'up to date. At the cap you get one final turn, and at 125% the run is interrupted.',
      );
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

  /** The mission's branch, when it has one: stay on it, and leave merging and pushing alone. */
  /**
   * Who is on this run's crew, by id, and which of them must pass before the
   * mission can be recorded as done.
   *
   * Without this the charter asks for a review the director has no way to
   * name: the ids live in `meta.crew`, which no prompt showed, so the only
   * route to them was calling the tool with a wrong id and reading the error.
   * A gate the director cannot see is a gate it fails by accident.
   */
  private crewLine(): string {
    const crew = this.meta.crew ?? [];
    if (!crew.length) return '';
    const rows = crew.map((p) => `  - ${p.id} — ${p.name}${p.model ? ` (${p.model})` : ''}: `
      + (p.requiredForDone
        ? 'REQUIRED. This run cannot be recorded as done until it returns VERDICT: PASS on the work as it finally stands.'
        : 'optional; ask for it when its subject is in play.')).join('\n');
    const required = crew.filter((p) => p.requiredForDone);
    return `\n\nYOUR CREW — call mcp__foreman__request_review with one of these ids:\n${rows}\n`
      + (required.length
        ? 'Request the required review AFTER your last change and before you tick the final box: a PASS is '
          + 'pinned to the work as it was reviewed, so anything you change afterwards makes it stale and the '
          + 'run reads as not done. If a review comes back FAIL, fix what it found and request it again.\n'
        : '');
  }

  private gitLine(): string {
    const g = this.meta.git;
    if (!g) return '';
    return `This mission runs on git branch ${g.branch}, created for it from ${g.base}. Stay on it: do not switch branches, ` +
      'do not merge, do not push, do not rebase or reset. You may commit as you go; Foreman commits whatever ' +
      'is left uncommitted when the mission ends. ';
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
    const turns = this.meta.maxTurns ?? DEFAULT_MAX_TURNS;
    const tokens = tokenCapLabel(this.meta.maxTokens ?? DEFAULT_MAX_TOKENS);
    switch (costBasisOf(this.meta)) {
      case 'free':
        return `This run costs nothing per token — it is served by hardware the ` +
          `operator already owns — so there is no spend cap. It is bounded by ` +
          `${turns} director turns and ${tokens}.`;
      case 'unpriced':
        // Deliberately still "no spend cap", and deliberately not silent about
        // the spend. A director told only that money is being spent, with no
        // figure and no cap, invents a limit and winds itself down early.
        return `This run does draw on a paid account, but Foreman cannot price it, ` +
          `so there is no dollar cap and no figure to reason about — do not ration ` +
          `yourself against one. It is bounded by ${turns} director turns and ${tokens}.`;
      case 'priced':
        return `Budget: $${this.meta.budgetUsd.toFixed(2)} total for this run.`;
    }
  }

  private budgetNote(): string {
    if (!isPriced(this.meta)) {
      return 'Budget note: this run has no dollar cap — any earlier message ' +
        'about a spend cap no longer applies, and you do not need authorisation ' +
        'to continue. Carry on to DONE WHEN.';
    }
    return `Budget note: $${this.meta.costUsd.toFixed(2)} of ` +
      `$${this.meta.budgetUsd.toFixed(2)} is already spent.`;
  }

  /** Appended to worker reports so the director can see the true burn rate
   *  (its own turn costs are invisible to it otherwise). */
  private costFooter(): string {
    if (!isPriced(this.meta)) {
      const u = this.meta.usage;
      const tokens = u ? u.inputTokens + u.outputTokens : 0;
      const basis = costBasisOf(this.meta) === 'free'
        ? 'not billed per token' : 'spend not tracked';
      return `\n\n[Run so far: ${this.turns} director turns` +
        `${tokens ? `, ${Math.round(tokens / 1000)}k tokens` : ''} — ${basis}]`;
    }
    return `\n\n[Run cost so far: $${this.meta.costUsd.toFixed(2)} of ` +
      `$${this.meta.budgetUsd.toFixed(2)} budget — includes director turns]`;
  }

  /**
   * Enforce the wall clock on a run that has stopped checking it itself.
   *
   * Runs on a timer rather than at a turn boundary, because the situation it
   * exists for is precisely one where turn boundaries have stopped happening:
   * a director waiting inside a tool call — message_worker, ask_human — on
   * something that will never answer. Only time is enforced here — turns and budget can only advance
   * *at* a turn boundary, so if none are happening neither can move.
   */
  private enforceCapsFromOutside(): void {
    if (this.hardStopped || this.wasInterrupted) return;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const maxSeconds = this.meta.maxSeconds ?? DEFAULT_MAX_SECONDS;
    if (elapsed < maxSeconds + CAP_WATCHDOG_GRACE_MS / 1000) return;
    this.hardStopped = true;
    this.meta.stopReason = 'time';
    this.saveMeta(this.meta);
    this.emit('budget_stop', {
      costUsd: this.meta.costUsd,
      budgetUsd: this.meta.budgetUsd,
      costBasis: costBasisOf(this.meta),
      metered: isPriced(this.meta),
      reason:
        `TIME CAP ENFORCED: ${Math.round(elapsed / 60)} minutes, past the ` +
        `${Math.round(maxSeconds / 60)}-minute cap and its grace period. The director did not ` +
        `wind down on its own, which usually means it was blocked waiting on something.`,
    });
    void this.interrupt();
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
    // gateway ends working runs over spend that never happened. Where it is
    // real it is the cap, full stop: a priced run is never ended by tokens,
    // which would cut a mission the human funded to its dollar figure.
    if (isPriced(this.meta)) {
      if (this.meta.costUsd < this.meta.budgetUsd) return null;
      return `BUDGET CAP REACHED: $${this.meta.costUsd.toFixed(2)} of $${this.meta.budgetUsd.toFixed(2)}.`;
    }
    // Unpriced or free: tokens are the bound dollars cannot be. Live usage
    // rather than the persisted total, so a gateway's interim tokens count too.
    const u = this.liveUsage();
    const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    if (total >= (this.meta.maxTokens ?? DEFAULT_MAX_TOKENS)) {
      return `TOKEN CAP REACHED: ${(total / 1e6).toFixed(1)}M tokens.`;
    }
    return null;
  }

  private overBudget(): string | null {
    const cap = this.capReached();
    if (!cap) return null;
    if (!isPriced(this.meta)) {
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
    this.meta.stopReason = stopReasonOf(cap);
    this.saveMeta(this.meta);
    this.emit('budget_stop', {
      costUsd: this.meta.costUsd,
      budgetUsd: this.meta.budgetUsd,
      costBasis: costBasisOf(this.meta),
      metered: isPriced(this.meta),
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

  /**
   * Item 6, decided as "ask": a worker on a gateway provider has stalled or
   * looped. Rather than letting the director cope alone or retrying somewhere
   * else on its own, the harness asks the human — in the tab and on their
   * phone — with the retry as a button: *continue (the director decides)*,
   * or *retry once on the director's provider*. Nobody answers in ten
   * minutes → continue. The fallback is therefore never automatic and never
   * more than one tap away, which is what reconciled "ask" with "fallback".
   *
   * A retry on the director's provider changes what the run's dollars mean —
   * a free or unpriced worker becomes a priced one — so the cost basis is
   * re-derived and announced before that worker spends a token. Only asked
   * when a retry target actually differs; a worker already on the director's
   * provider has nowhere else to go.
   */
  private async askFallback(
    workerId: string, prompt: string, outcome: WorkerOutcome, why: 'stalled' | 'looping',
  ): Promise<WorkerOutcome> {
    const rb = this.roleBasis;
    const sameTarget = !rb
      || (this.agentEnv.director === this.agentEnv.worker
        && (this.meta.directorModel || '') === (this.meta.workerModel || ''));
    if (sameTarget) return outcome;

    const directorLabel = this.meta.directorModel || 'the director\'s model';
    const options = [
      'Continue — the director decides what to do next',
      `Retry once on the director's provider (${directorLabel})`,
    ];
    const id = `q-${Date.now()}-fallback-${workerId}`;
    const question =
      `${workerId} ${why} on ${this.meta.workerModel || 'the worker model'}. ` +
      `Continue and let the director decide, or retry the same brief once on ${directorLabel}?`;
    this.askMeta.set(id, { kind: 'question', text: question, options, since: Date.now() });
    this.emit('question', { id, question, options, harness: true });
    const answer = await new Promise<string>((resolve) => {
      this.pendingQuestions.set(id, resolve);
      this.armAsk(id, (afterMs) => {
        if (!this.pendingQuestions.delete(id)) return;
        this.askMeta.delete(id);
        this.emit('question_timeout', { id, afterMs });
        resolve(options[0]);
      });
    });
    if (!answer.toLowerCase().startsWith('retry')) {
      this.emit('question_answered', { id });
      return outcome;
    }
    this.emit('question_answered', { id });

    // The human chose to spend on the director's provider: say what that
    // does to the money before it happens.
    const nb = combineBasis(costBasisOf(this.meta), rb.director);
    if (nb !== costBasisOf(this.meta)) {
      this.meta.costBasis = nb;
      this.meta.metered = nb === 'priced';
      this.emit('settings_changed', {
        changes: [`retrying ${workerId} on the director's provider — this run is now ${nb}` +
          (nb === 'priced' ? ' and the dollar cap is live' : '')],
        browserTools: Boolean(this.meta.browserTools), budgetUsd: this.meta.budgetUsd,
      });
      this.saveMeta(this.meta);
      this.emitEconomics();
    }
    const nextId = `worker-${++this.workerSeq}`;
    this.launchWorker(nextId, prompt, undefined, {
      env: this.agentEnv.director, model: this.meta.directorModel || undefined, priceRole: 'director',
      // A reviewer retried elsewhere is still a reviewer. Changing which
      // provider serves it must not hand it Write, Edit and Bash: the
      // restriction belongs to the job, not to the endpoint.
      toolPolicy: this.workers.get(workerId)?.overrides?.toolPolicy,
      crewPresetId: this.workers.get(workerId)?.crewPresetId,
      reason: `retry of ${workerId} on the director's provider, at the human's request`,
    });
    return {
      isError: true,
      report: `${outcome.report}\n\nTHE HUMAN CHOSE TO RETRY: the same brief is now running as ${nextId} on ` +
        `${directorLabel}. Supervise ${nextId} with check_workers / wait_for_worker; do not respawn this brief yourself.`,
    };
  }

  /**
   * Starts a worker and returns at once; the session runs in the background.
   *
   * The split between this and {@link runWorker} is the asynchronous design in
   * one place: everything the director can observe about a worker — the record
   * in the map, `worker_started`, the `done` promise wait_for_worker races, the
   * stored report and `worker_finished` at the end — is settled here, around a
   * runWorker that only drives the SDK session. The promise is kept on the
   * record rather than dropped, so a worker is never a floating promise, and
   * the outcome is written onto the record rather than returned once, because
   * the director now reads it back whenever it asks.
   *
   * Synchronous up to the point runWorker takes over: by the time this returns
   * the record exists and `worker_started` has been emitted, which is exactly
   * the guarantee spawn_worker's immediate reply relies on.
   */
  private launchWorker(workerId: string, prompt: string, resumeSessionId?: string, overrides?: WorkerOverrides): WorkerRuntime {
    const existing = this.workers.get(workerId);
    const w: WorkerRuntime = existing ?? {
      id: workerId, status: 'running', costUsd: 0, task: prompt.slice(0, 500),
    };
    const now = Date.now();
    // A resumed worker is a new episode: fresh clock, fresh report. Its call
    // count and recent lines carry over, since they are the history the
    // director may be following.
    w.status = 'running';
    w.startedAt = now;
    w.lastActivityAt = now;
    w.endedAt = undefined;
    w.report = undefined;
    w.isError = undefined;
    w.reportShown = false;
    w.toolCalls ??= 0;
    // Kept for the resume path: see WorkerRuntime.overrides. A resume passes
    // these back in, so `overrides ?? w.overrides` is what a follow-up uses.
    if (overrides) w.overrides = overrides;
    if (overrides?.crewPresetId) w.crewPresetId = overrides.crewPresetId;
    w.recent ??= [];
    w.done = new Promise<void>((resolve) => { w.settle = resolve; });
    this.workers.set(workerId, w);
    this.syncWorkersMeta();
    this.emit('worker_started', {
      id: workerId, task: prompt.slice(0, 200), resumed: Boolean(resumeSessionId),
      ...(overrides?.reason ? { reason: overrides.reason } : {}),
    });

    w.promise = this.runWorker(workerId, prompt, resumeSessionId, overrides)
      // runWorker catches its own failures; this is the belt for anything it
      // could not, because an unsettled `done` would hang a wait_for_worker.
      .catch((err): WorkerOutcome => ({ report: `Worker crashed: ${String(err)}`, isError: true }))
      .then((out) => {
        w.q = undefined;
        w.report = out.report;
        w.isError = out.isError;
        w.status = out.isError ? 'error' : 'done';
        w.endedAt = Date.now();
        this.syncWorkersMeta();
        this.emit('worker_finished', {
          id: workerId, status: w.status, sessionId: w.sessionId, report: out.report,
        });
        w.settle?.();
        return out;
      });
    return w;
  }

  /**
   * Drives one worker session to its end and hands back the outcome. Does not
   * touch the record's status or report — that is {@link launchWorker}'s
   * job, once, for every path this can exit by — but it does keep the
   * record's live activity fields current, because those are what
   * check_workers shows while this is still running.
   */
  private async runWorker(workerId: string, prompt: string, resumeSessionId?: string, overrides?: WorkerOverrides):
    Promise<WorkerOutcome> {
    const w = this.workers.get(workerId);
    if (!w) throw new Error(`runWorker: no record for ${workerId}; launchWorker creates it`);

    const q = query({
      prompt,
      options: {
        cwd: this.meta.folder,
        permissionMode: 'default',
        resume: resumeSessionId,
        model: overrides?.model || this.meta.workerModel,
        maxTurns: WORKER_MAX_TURNS,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: WORKER_CHARTER },
        ...(overrides?.env ?? this.agentEnv.worker),
        // Built per worker: the report_progress handler closes over this id,
        // which is how a report lands on the right record without the worker
        // having to know its own name.
        mcpServers: { foreman: this.workerTools(workerId), ...this.browserServers() },
        canUseTool: this.policyFor(workerId, overrides?.toolPolicy),
      },
    });
    w.q = q;

    let report = '';
    let hitTurnCap = false;
    let isError = false;

    // The stall watchdog. A silent worker no longer blocks the director, but
    // it still occupies a slot the director believes is working, still counts
    // toward the run's wall clock, and still ends up in a wait_for_worker
    // sooner or later — so it is stopped and reported rather than left to the
    // run's time cap hours later. Every message resets it; only silence trips it.
    const silenceMs = this.meta.workerSilenceMs ?? DEFAULT_WORKER_SILENCE_MS;
    let stalled = false;
    const watchdog = watchSilence(silenceMs, (quietFor) => {
      stalled = true;
      this.emit('worker_stalled', {
        id: workerId, quietForMs: quietFor,
        text: `${workerId} has produced nothing for ${Math.round(quietFor / 60_000)} minute(s) — stopping it.`,
      });
      // Interrupting ends the for-await below, which is what lets the
      // director be told rather than left waiting.
      void w.q?.interrupt().catch(() => {});
    });
    // The other stall: busy but looping. Each identical call touches the
    // silence watchdog above, so without this one a worker re-running the
    // same failing command is indistinguishable from one making progress —
    // until the budget says otherwise. A worker, unlike the director, has no
    // wider context to recover with, so it is stopped and the director told.
    // Created per runWorker call, so a new or resumed worker starts clean.
    let looping: { toolName: string; count: number } | null = null;
    const repeats = watchRepeats(DEFAULT_REPEAT_LIMIT, ({ toolName, count }) => {
      looping = { toolName, count };
      this.emit('worker_looping', {
        id: workerId, toolName, count,
        text: `${workerId} issued the identical ${toolName} call ${count} times in a row — stopping it.`,
      });
      void w.q?.interrupt().catch(() => {});
    });

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        watchdog.touch();
        const m = msg as Record<string, unknown>;
        if (typeof m.session_id === 'string') w.sessionId = m.session_id;
        this.noteActivity(w, m);
        for (const t of toolUsesOf(m)) observeToolUse(repeats, t.name, t.input);
        if (m.type === 'result') {
          report = String(m.result ?? '');
          isError = Boolean(m.is_error);
          hitTurnCap = m.subtype === 'error_max_turns' || /maximum number of turns/i.test(report);
          this.noteUsageLimit(report);
          // Same ordering rule as the director loop: the cost event carries
          // usage, so usage has to be current before it is emitted.
          // A worker retried on the director's provider is priced with the
          // director's rates: the tokens went through that gateway.
          this.addUsage(m.usage, overrides?.priceRole ?? 'worker');
          this.addCost(m.total_cost_usd as number | undefined, overrides?.priceRole ?? 'worker', overrides?.nativeCost === true);
          w.costUsd += (m.total_cost_usd as number | undefined) ?? 0;
        }
        this.emit('message', { agent: workerId, msg });
      }
    } catch (err) {
      isError = true;
      report = report || `Worker crashed: ${String(err)}`;
    } finally {
      watchdog.stop();
      w.q = undefined;
    }

    // A worker stopped by the turn cap mid-task is not a failed worker. Its
    // session is resumed once with a continue turn — the same context, the
    // same files — instead of handing the director an error it can only
    // answer by spawning a replacement that re-reads everything. Once: a
    // worker that burns two allowances is stuck, and that IS the director's.
    if (hitTurnCap && !overrides?.continued && w.sessionId && !stalled && !looping) {
      this.emit('worker_progress', { id: workerId, status: `reached the ${WORKER_MAX_TURNS}-turn cap mid-task; continuing the same session once` });
      return this.runWorker(workerId, WORKER_CONTINUE_PROMPT, w.sessionId, { ...overrides, continued: true });
    }

    // Told to the director as a fact plus its options, not as an order: it is
    // the agent with the context to know whether this needs a different
    // approach, a different worker, or a human.
    // A retry that itself stalls is not offered another retry: the fallback
    // is one tap, once, not a ladder.
    if (stalled) {
      const out: WorkerOutcome = { isError: true, report: stalledWorkerReport(workerId, silenceMs, report) };
      return overrides?.env ? out : this.askFallback(workerId, prompt, out, 'stalled');
    }
    if (looping) {
      const { toolName, count } = looping as { toolName: string; count: number };
      const out: WorkerOutcome = { isError: true, report: loopingWorkerReport(workerId, toolName, count, report) };
      return overrides?.env ? out : this.askFallback(workerId, prompt, out, 'looping');
    }
    return { report, isError };
  }

  /**
   * Folds one SDK message into the record's live view: the activity clock,
   * the call count, and the rolling `recent` window. Tool calls get a line
   * each; an assistant message with only text gets its opening words, which
   * is usually the worker saying what it is about to do.
   */
  private noteActivity(w: WorkerRuntime, m: Record<string, unknown>): void {
    w.lastActivityAt = Date.now();
    const uses = toolUsesOf(m);
    // A report_progress call is counted but not hinted: its handler writes
    // the fuller `progress:` line into the window itself, and the same status
    // twice in eight lines would push out a line that said something.
    const lines = uses.filter((t) => t.name !== REPORT_PROGRESS_TOOL).map((t) => activityHint(t.name, t.input));
    if (uses.length) w.toolCalls = (w.toolCalls ?? 0) + uses.length;
    else if (m.type === 'assistant') {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      const textBlock = Array.isArray(content)
        ? content.find((b) => b && (b as { type?: unknown }).type === 'text') as { text?: unknown } | undefined
        : undefined;
      if (typeof textBlock?.text === 'string' && textBlock.text.trim()) lines.push(`"${oneLine(textBlock.text, 80)}"`);
    }
    this.pushRecent(w, lines);
  }

  /** Appends to the rolling window, dropping the oldest past RECENT_LINES. */
  private pushRecent(w: WorkerRuntime, lines: string[]): void {
    if (!lines.length) return;
    w.recent = [...(w.recent ?? []), ...lines].slice(-RECENT_LINES);
  }

  private syncWorkersMeta(): void {
    this.meta.workers = [...this.workers.values()].map((w) => {
      const copy: Partial<WorkerRuntime> = { ...w };
      for (const k of RUNTIME_ONLY) delete copy[k];
      return copy as WorkerMeta;
    });
    this.saveMeta(this.meta);
  }

  // -- worker tools -----------------------------------------------------------

  /**
   * report_progress, the one Foreman tool a worker has. Stores the report on
   * the record, drops a `progress:` line into `recent` so the timeline shows
   * when the worker said it, and emits it for the UI. The status is capped
   * rather than rejected: a worker that wrote a paragraph still reported, and
   * the director would rather have its first 200 chars than an error.
   *
   * An unknown id is a no-op, not a throw: the only way to reach it is a
   * worker whose record was dropped under it, and failing its tool call would
   * make that worker's turn stranger, not the record come back.
   */
  private reportProgressTool(
    workerId: string,
    { status, done, next, blocked }: { status: string; done?: string[]; next?: string; blocked?: string },
  ): string {
    const w = this.workers.get(workerId);
    if (!w) return `No record for ${workerId}; progress not stored.`;
    const clean = (s: string | undefined) => (s && s.trim() ? oneLine(s, PROGRESS_STATUS_MAX) : undefined);
    const progress: WorkerProgress = {
      status: clean(status) ?? '(no status)',
      at: Date.now(),
    };
    const steps = (done ?? []).map((d) => clean(d)).filter((d): d is string => d !== undefined);
    if (steps.length) progress.done = steps;
    const n = clean(next);
    if (n) progress.next = n;
    const b = clean(blocked);
    if (b) progress.blocked = b;
    w.progress = progress;
    this.pushRecent(w, [`progress: ${progress.status}${b ? ` — BLOCKED: ${b}` : ''}`]);
    this.syncWorkersMeta();
    this.emit('worker_progress', {
      id: workerId, status: progress.status, done: progress.done, next: progress.next, blocked: progress.blocked,
    });
    return b
      ? 'Noted, including the blocker — the director can see it. Continue with whatever is not blocked, ' +
        'or end your turn with "BLOCKED: <question>" if nothing is.'
      : 'Noted. Continue.';
  }

  /** The per-worker `foreman` MCP server; see {@link reportProgressTool}. */
  private workerTools(workerId: string) {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const reportProgress = tool(
      'report_progress',
      'Tell the director where you are. Call it when you finish a distinct sub-step, when you ' +
      'change approach, and immediately when you are blocked. One line of status; optionally the ' +
      'sub-steps done so far, what you are about to do, and what you cannot get past.',
      {
        status: z.string().describe(`One-line summary of where you are (max ${PROGRESS_STATUS_MAX} chars)`),
        done: z.array(z.string()).optional().describe('Sub-steps completed so far'),
        next: z.string().optional().describe('What you are about to do'),
        blocked: z.string().optional().describe('Anything you cannot get past, stated so someone else could act on it'),
      },
      async (args) => text(this.reportProgressTool(workerId, args)),
    );
    return createSdkMcpServer({ name: 'foreman', tools: [reportProgress] });
  }

  // -- director tools ---------------------------------------------------------
  //
  // Handler bodies live on the class and return plain text; makeTools() only
  // wraps them in MCP definitions. That keeps the director's tool surface
  // testable without an MCP server — the tests stub runWorker and drive these
  // directly — and keeps the rule (what the director is told, when) apart from
  // the plumbing (how it gets there).

  /** `[worker-3 finished] <report>` — the shape every result reaches the director in. */
  private reportLine(w: WorkerRuntime): string {
    w.reportShown = true;
    return `[${w.id}${w.isError ? ' FAILED' : ' finished'}] ${w.report || '(no report)'}`;
  }

  private spawnWorkerTool({ task }: { task: string }): string {
    const stop = this.overBudget();
    if (stop) return stop;
    const id = `worker-${++this.workerSeq}`;
    // The worker gets the project's notes with its brief: what earlier crews
    // learned is exactly what a fresh session lacks.
    this.launchWorker(id, this.memoryForWorkers ? `${task}\n${this.memoryForWorkers}` : task);
    return `[${id} started] status: running. It works in the background — use check_workers ` +
      `to watch it, and wait_for_worker when you need its result.`;
  }

  /**
   * request_review — hand the run's diff to a crew reviewer and wait for its
   * verdict.
   *
   * Unlike spawn_worker this AWAITS: the director asked a question and the
   * answer is the whole point of the call. The reviewer is an ordinary worker
   * in every other respect — same id sequence, same budget, same transcript —
   * because a review that did not count against the run's spend would be a
   * cost nobody could see, and a reviewer with a second kind of id would make
   * every other surface learn a shape it does not need.
   *
   * What it is NOT is a way to ask nicely. The verdict is recorded on the run
   * whatever the director does with it, and the gate in the end-of-run
   * `finally` reads that record, not this conversation.
   */
  /**
   * The launch overrides for a worker that is a crew preset, rebuilt from the
   * run's frozen crew. Used when the record survived a resume but the live
   * overrides did not: they hold a credential and are deliberately not
   * persisted, while the restriction they carry must not lapse.
   */
  private overridesForPreset(presetId?: string): WorkerOverrides | undefined {
    if (!presetId) return undefined;
    const preset = (this.meta.crew ?? []).find((p) => p.id === presetId);
    if (!preset) return undefined;
    return {
      model: preset.model || this.meta.workerModel,
      env: this.agentEnv.crew?.[preset.id],
      toolPolicy: preset.toolPolicy === 'default' ? undefined : REVIEWER_TOOL_POLICY,
      nativeCost: Boolean(this.agentEnv.crew?.[preset.id]) && this.roleBasis?.crew?.[preset.id] === 'priced',
      crewPresetId: preset.id,
      reason: `follow-up to ${preset.name} (${preset.id})`,
    };
  }

  private async requestReviewTool({ presetId, notes }: { presetId: string; notes?: string }): Promise<string> {
    const crew = this.meta.crew ?? [];
    if (!crew.length) {
      return 'This run has no crew: nobody was added as a reviewer when it was dispatched, so ' +
        'there is nothing to request a review from. Verify the work yourself and say so in your report.';
    }
    const preset = crew.find((p) => p.id === presetId);
    if (!preset) {
      return `No crew preset "${presetId}" on this run. Available: ${crew.map((p) => p.id).join(', ')}.`;
    }
    const stop = this.overBudget();
    if (stop) return stop;

    // The diff as Foreman sees it — the same deck the gate will hash — so a
    // PASS is about the change Foreman will check, not about whatever the
    // reviewer happened to look at.
    // What the reviewer READS is the deck, which is a capped view. What the
    // PASS is PINNED TO is the working tree itself — see changeFingerprint.
    // A review that cannot be pinned is not worth having: it would clear the
    // gate for a diff nobody can prove was the one read.
    const fingerprint = await changeFingerprint(this.meta.folder);
    if (fingerprint === null) {
      return 'Foreman cannot read what this run has changed (the folder is not a git repository, or git ' +
        'would not answer), so a review cannot be pinned to it and would not clear the gate. Verify the ' +
        'work yourself, say so plainly in your report, and record in MISSION.md that no review was possible.';
    }
    const deck = await deckFor(this.meta.folder, this.meta.id);
    if (deck.baseline?.kind === 'none') {
      return 'Foreman has no baseline for this run, so it cannot show a reviewer what changed — the deck ' +
        'is empty whatever the crew did. A PASS on nothing would clear the gate on nothing, so no review ' +
        'is requested. Say this in your report.';
    }
    const { diff, truncated } = renderDeckDiff(deck);
    const doc = await this.missionDoc();
    const doneWhen = (doc === null ? null : doneWhenSection(doc))?.join('\n') ?? '';
    let prompt = reviewBriefFor(preset, { mission: this.meta.mission, doneWhen, diff, truncated });
    if (notes?.trim()) prompt += `\n\n## The director asks you to pay particular attention to\n\n${notes.trim()}`;

    // A reviewer on a priced provider spends real money even when the rest of
    // the run does not, and a dollar cap that is not "live" is not enforced at
    // all — enforceBudget and capReached both stand down on an unpriced run.
    // So the basis moves BEFORE the reviewer is launched, and says so, exactly
    // as the fallback path does when a human retries on the director's.
    const presetBasis = this.agentEnv.crew?.[preset.id] ? this.roleBasis?.crew?.[preset.id] : undefined;
    if (presetBasis) {
      const nb = combineBasis(costBasisOf(this.meta), presetBasis);
      if (nb !== costBasisOf(this.meta)) {
        this.meta.costBasis = nb;
        this.meta.metered = nb === 'priced';
        this.emit('settings_changed', {
          changes: [`${preset.name} reviews on its own provider — this run is now ${nb}`
            + (nb === 'priced' ? ' and the dollar cap is live' : '')],
          browserTools: Boolean(this.meta.browserTools), budgetUsd: this.meta.budgetUsd,
        });
        this.saveMeta(this.meta);
        this.emitEconomics();
      }
    }

    const id = `worker-${++this.workerSeq}`;
    const w = this.launchWorker(id, prompt, undefined, {
      model: preset.model || this.meta.workerModel,
      // The preset's own provider, when dispatch managed to resolve one for it;
      // undefined leaves runWorker on the worker env. A reviewer is still worth
      // running on a fallback provider — refusing to review because a provider
      // was deleted after the crew was chosen would strand the run at the one
      // step that lets it be called done.
      //
      // Its tokens are still priced at the WORKER role's rates, deliberately.
      // Per-preset pricing would mean a fourth rate card and a fourth gateway
      // bucket for a handful of turns; a mixed run already resolves to the
      // dearer basis rather than the cheaper one (see combineBasis in types.ts),
      // so the error this leaves behind overstates spend, which is the side a
      // cost cap should be wrong on.
      env: this.agentEnv.crew?.[preset.id],
      // A preset with an env of its own is served by that provider, so its
      // basis — not the worker role's — decides whether its dollars are real.
      nativeCost: presetBasis === 'priced',
      // 'default' is the preset saying this role needs to run things; anything
      // else gets the flat deny, which is what makes "read-only" provable.
      toolPolicy: preset.toolPolicy === 'default' ? undefined : REVIEWER_TOOL_POLICY,
      crewPresetId: preset.id,
      reason: `review by ${preset.name} (${preset.id})`,
    });
    const outcome = await w.promise;

    const parsed = parseVerdict(outcome?.report ?? '');
    const verdict: ReviewVerdict = {
      presetId: preset.id,
      name: preset.name,
      // No verdict line is not a pass. The reviewer may have run out of turns
      // or answered in prose; either way nobody has said this diff is good,
      // and the gate must not treat silence as consent.
      pass: parsed?.pass ?? false,
      findings: parsed?.findings
        ?? `${preset.name} never stated a verdict. Its report ended without the required ` +
           `\`VERDICT: PASS\`/\`VERDICT: FAIL\` line, so this counts as a FAIL.` +
           (outcome?.report ? `\n\nWhat it did report:\n${outcome.report}` : ''),
      diffHash: fingerprint,
      workerId: id,
      costUsd: this.workers.get(id)?.costUsd,
      at: Date.now(),
    };
    this.meta.reviews = [...(this.meta.reviews ?? []), verdict];
    this.saveMeta(this.meta);
    this.emit('review_verdict', {
      presetId: verdict.presetId, name: verdict.name, model: preset.model || this.meta.workerModel,
      pass: verdict.pass, findings: verdict.findings, diffHash: verdict.diffHash,
      workerId: verdict.workerId, costUsd: verdict.costUsd,
    });

    const head = parsed === null
      ? `[${preset.name} (${id}) returned NO VERDICT — recorded as a FAIL]`
      : `[${preset.name} (${id}) — VERDICT: ${verdict.pass ? 'PASS' : 'FAIL'}]`;
    const tail = verdict.pass
      ? 'This PASS is pinned to the diff as it stands right now. If you change anything after ' +
        'this, the PASS goes stale and the run will not be recorded done — so review last.'
      : 'This review must pass before the run can be recorded done. Fix what it names, then call ' +
        'request_review again.';
    return `${head}\n${verdict.findings || '(no findings given)'}\n\n${tail}${this.costFooter()}`;
  }

  /**
   * THE GATE, as the end of the run sees it: null when nothing required is
   * outstanding, otherwise the blockers and the sentence for the event.
   *
   * A deck that cannot be computed leaves the gate UNSATISFIED rather than
   * open. "We could not work out what this run changed" is not evidence that
   * what it changed was reviewed, and the failure mode of the other reading —
   * a diff error quietly certifying a run as done — is the one this whole
   * mechanism exists to prevent.
   */
  private async reviewGate(): Promise<{ blockers: ReviewBlocker[]; text: string } | null> {
    const required = (this.meta.crew ?? []).filter((p) => p.requiredForDone);
    if (!required.length) return null;
    // deckFor never throws: a missing baseline comes back as a deck with
    // `baseline.kind === 'none'` and no files, which would hash like a clean
    // tree and let any PASS stand. So the gate asks git directly, and treats
    // "cannot tell" as "not reviewed" rather than as "unchanged".
    const fingerprint = await changeFingerprint(this.meta.folder);
    if (fingerprint === null) {
      return {
        blockers: required.map((p) => ({ presetId: p.id, name: p.name, reason: 'missing' as const })),
        text: `This run's diff could not be computed, so no review can be matched to it. ` +
          `${required.map((p) => p.name).join(', ')} ` +
          `${required.length === 1 ? 'is' : 'are'} required to pass before this run is done, and ` +
          'nothing here shows that happened. This run is not done. Resume to continue it.',
      };
    }
    const blockers = reviewBlockers(this.meta.crew, this.meta.reviews, fingerprint);
    return blockers.length ? { blockers, text: unreviewedText(blockers) } : null;
  }

  private async messageWorkerTool({ worker_id, message }: { worker_id: string; message: string }): Promise<string> {
    const stop = this.overBudget();
    if (stop) return stop;
    const w = this.workers.get(worker_id);
    if (!w?.sessionId) return `No resumable worker "${worker_id}".`;
    // Two sessions resuming the same id at once would interleave on one
    // transcript; the message waits for the worker, not the other way round.
    if (w.status === 'running') {
      return `${worker_id} is still running — wait_for_worker it first, then send the follow-up.`;
    }
    // A reviewer's read-only policy, model and provider live in the overrides
    // its first launch was given. Resuming without them would hand the
    // director a worker that may now write, on whatever model the run's
    // workers use — the restriction would quietly expire at the first
    // follow-up question.
    const run = this.launchWorker(worker_id, message, w.sessionId, w.overrides ?? this.overridesForPreset(w.crewPresetId));
    await run.promise;
    return `${this.reportLine(run)}${this.costFooter()}`;
  }

  private checkWorkersTool({ workerId }: { workerId?: string } = {}): string {
    if (workerId) {
      const w = this.workers.get(workerId);
      if (!w) return `No worker "${workerId}".${this.costFooter()}`;
      w.reportShown = w.reportShown || w.status !== 'running';
      return `${workerStatusBlock(w)}${this.costFooter()}`;
    }
    const all = [...this.workers.values()];
    if (!all.length) return `No workers have been spawned in this run.${this.costFooter()}`;
    const now = Date.now();
    for (const w of all) if (w.status !== 'running') w.reportShown = true;
    return `${all.map((w) => workerStatusBlock(w, now)).join('\n\n')}${this.costFooter()}`;
  }

  private async waitForWorkerTool(
    { workerId, timeoutSeconds }: { workerId?: string; timeoutSeconds?: number } = {},
  ): Promise<string> {
    const secs = Math.min(MAX_WAIT_SECONDS, Math.max(0,
      typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) ? timeoutSeconds : DEFAULT_WAIT_SECONDS));

    let targets: WorkerRuntime[];
    if (workerId) {
      const w = this.workers.get(workerId);
      if (!w) return `No worker "${workerId}".${this.costFooter()}`;
      if (w.status !== 'running') return `${this.reportLine(w)}${this.costFooter()}`;
      targets = [w];
    } else {
      targets = [...this.workers.values()].filter((w) => w.status === 'running');
      if (!targets.length) {
        return `No worker is running. ${this.workers.size ? 'check_workers shows the finished ones.' : ''}`.trim() +
          this.costFooter();
      }
    }

    // Raced against a timer, and the timer is cleared on both exits: a stray
    // timeout outliving the run would keep the event loop, and with it the
    // process, alive for up to ten minutes after the last mission ended.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), secs * 1000); });
    const first = await Promise.race<WorkerRuntime | null>([
      ...targets.map((w) => (w.done ?? Promise.resolve()).then(() => w)),
      timeout,
    ]).finally(() => clearTimeout(timer));

    if (!first) {
      const now = Date.now();
      return `${targets.map((w) => workerStatusBlock(w, now)).join('\n\n')}\n\n` +
        `Still running after ${secs}s. Call wait_for_worker again to keep waiting, or ` +
        `check_workers to look without waiting.${this.costFooter()}`;
    }
    return `${this.reportLine(first)}${this.costFooter()}`;
  }

  private makeTools() {
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

    const spawnWorker = tool(
      'spawn_worker',
      'Start a worker agent on one self-contained implementation task in the working ' +
      'directory. Returns immediately with the worker id; the worker runs in the background. ' +
      'Spawn independent tasks together so they run in parallel. Follow with check_workers ' +
      'to supervise and wait_for_worker to collect the result. Include all context the ' +
      'worker needs: it does not see your conversation.',
      { task: z.string().describe('Full task description with context, paths, and the expected result') },
      async (args) => text(this.spawnWorkerTool(args)),
    );

    const requestReview = tool(
      'request_review',
      'Hand this run\'s diff to one of the crew\'s reviewers and get its verdict. Unlike ' +
      'spawn_worker this WAITS and returns the findings. The reviewer reads only — it cannot ' +
      'change your code — and its verdict is recorded on the run: a reviewer marked required ' +
      'must return PASS on the FINAL diff before Foreman will record the run as done, so call ' +
      'this after your last change, not before.',
      {
        presetId: z.string().describe('The crew preset id to review, e.g. "reviewer"'),
        notes: z.string().optional().describe('Anything specific you want it to look at, beyond its standing brief'),
      },
      async (args) => text(await this.requestReviewTool(args)),
    );

    const checkWorkers = tool(
      'check_workers',
      'Show every worker (or one): status, age, seconds since its last activity, tool calls ' +
      'so far, its most recent actions, and — once finished — its full report. Does not wait.',
      { workerId: z.string().optional().describe('One worker id, e.g. "worker-2"; omit for all') },
      async (args) => text(this.checkWorkersTool(args)),
    );

    const waitForWorker = tool(
      'wait_for_worker',
      'Wait until a worker finishes (or, with no id, until any running worker finishes) and ' +
      `return its report. Bounded: default ${DEFAULT_WAIT_SECONDS}s, at most ${MAX_WAIT_SECONDS}s; ` +
      'on timeout it returns the current status and you may call it again.',
      {
        workerId: z.string().optional().describe('The worker to wait for; omit to wait for whichever finishes first'),
        timeoutSeconds: z.number().optional().describe(`Seconds to wait (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS})`),
      },
      async (args) => text(await this.waitForWorkerTool(args)),
    );

    const messageWorker = tool(
      'message_worker',
      'Send a follow-up message to a finished worker (correction, next step, answer to a ' +
      "BLOCKED question). Resumes that worker's session with its prior context intact. " +
      'Blocks until the worker finishes and returns its report.',
      {
        worker_id: z.string().describe('The worker id, e.g. "worker-1"'),
        message: z.string().describe('The follow-up instruction or answer'),
      },
      async (args) => text(await this.messageWorkerTool(args)),
    );

    const askHuman = tool(
      'ask_human',
      'Ask the human overseer a question and wait for their answer. Use for anything ' +
      'irreversible, out of scope, over budget, or that only a human can decide.',
      {
        question: z.string().describe('The question, with enough context to answer it'),
        options: z.array(z.string()).min(2).max(6).optional().describe(
          'When the answer is a choice, the choices — recommended first. The human ' +
          'taps one (in the tab or on their phone) instead of typing; they can still type.'),
      },
      async ({ question, options }) => {
        const id = `q-${Date.now()}-${this.pendingQuestions.size}`;
        const opts = options?.map((o) => o.trim()).filter(Boolean).slice(0, 6);
        this.askMeta.set(id, { kind: 'question', text: question, options: opts?.length ? opts : undefined, since: Date.now() });
        this.emit('question', { id, question, ...(opts?.length ? { options: opts } : {}) });
        // Same unattended default as a permission card, with the opposite
        // polarity: a question is not refused, it is handed back. The
        // director keeps its context and is told to decide and record.
        let timedOut = false;
        const answer = await new Promise<string>((resolve) => {
          this.pendingQuestions.set(id, resolve);
          this.armAsk(id, (afterMs) => {
            if (!this.pendingQuestions.delete(id)) return;
            this.askMeta.delete(id);
            timedOut = true;
            this.emit('question_timeout', { id, afterMs });
            resolve(unattendedAnswer(afterMs));
          });
        });
        if (timedOut) return text(answer);
        this.emit('question_answered', { id });
        return text(`Human answered: ${answer}`);
      },
    );

    const exposeService = tool(
      'expose_service',
      'Make a local server the crew started (a dev server, a preview) reachable for the ' +
      'human through Foreman, including from their phone. Give the port it listens on at ' +
      '127.0.0.1; you get back the URL to put in your report. Only ports something is ' +
      'actually listening on; only for this run.',
      {
        port: z.number().int().min(1).max(65535).describe('The local port the service listens on'),
        label: z.string().max(60).optional().describe('What it is, in a few words — "preview", "storybook", "API docs"'),
      },
      async ({ port, label }) => {
        const fn = this.host.exposeService;
        if (!fn) return { content: [{ type: 'text' as const, text: 'Exposing services is not available in this run.' }] };
        const r = await fn(this.meta.id, port, (label ?? '').trim() || `port ${port}`);
        if (!r.ok) return { content: [{ type: 'text' as const, text: `Not exposed: ${r.reason}` }] };
        const entry = { port, label: (label ?? '').trim() || `port ${port}`, path: r.path, since: Date.now(), pid: r.pid };
        this.meta.services = [...(this.meta.services ?? []).filter((s) => s.port !== port), entry];
        this.saveMeta(this.meta);
        this.emit('service_exposed', { ...entry, url: r.url });
        return { content: [{ type: 'text' as const, text:
          `Exposed. The human can open it at ${r.url} (Foreman proxies it to 127.0.0.1:${port}; ` +
          'absolute links inside the page resolve while the page is open from that URL). Keep the server ' +
          'running while they may want to look, and put the URL in your report.' }] };
      },
    );
    const remember = tool(
      'remember',
      'Rewrite the project memory (.foreman/MEMORY.md): the whole page as it should read now, ' +
      'for the next crew. Facts about this project — how to run and test it, ports and paths, ' +
      'conventions and why, traps — one line each, a page at most. Replace stale lines; do not ' +
      'append forever. Never a secret; anything that looks like one is stripped.',
      { text: z.string().max(20_000).describe('The complete memory file content, Markdown') },
      async ({ text: body }) => {
        const r = await writeMemory(this.meta.folder, body);
        this.emit('memory_updated', { bytes: r.bytes, redacted: r.redacted, trimmed: r.trimmed,
          text: `Project memory rewritten (${r.bytes} bytes${r.redacted ? `, ${r.redacted} secret-looking value${r.redacted === 1 ? '' : 's'} stripped` : ''}${r.trimmed ? ', trimmed to the cap' : ''}).` });
        return { content: [{ type: 'text' as const, text:
          `Memory written (${r.bytes} bytes).${r.redacted ? ` ${r.redacted} value(s) that looked like secrets were replaced with [redacted]; do not put credentials in memory.` : ''}${r.trimmed ? ' It was longer than the cap and has been cut at the end — prune it to a page.' : ''}` }] };
      },
    );
    return createSdkMcpServer({
      name: 'foreman',
      tools: [spawnWorker, requestReview, checkWorkers, waitForWorker, messageWorker, askHuman, exposeService, remember],
    });
  }
}
