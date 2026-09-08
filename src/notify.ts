/**
 * Notifications — a tap on the shoulder, wherever the human actually is.
 *
 * Foreman runs missions unattended, and every ask already carries an
 * unattended default: ten minutes unanswered and the safe answer is applied.
 * That keeps the mission alive by deciding in silence. A channel changes the
 * layering to **notify → wait → default**: the human is told where they are,
 * and the default becomes what happens when they genuinely cannot answer —
 * not what happens because they never knew.
 *
 * Three rules shape everything here:
 *
 *  - **One subscription point.** The hub hangs off the same broadcast the SSE
 *    clients receive; nothing in the orchestrator knows notifications exist.
 *    An event that reaches the UI can reach a phone, and one that does not,
 *    cannot — the SSE contract test already guards that list.
 *  - **Curated, not a firehose.** Only what a human should know: something
 *    needs them, something stalled, something was decided for them, a run
 *    ended. The existing Settings toggles (needs you / run finished / budget)
 *    are the filter, so a channel obeys the same preferences the tab does.
 *  - **Never a second answer pipeline.** Answering from the channel (Phase B)
 *    produces the same calls the picker and the approval card make — the
 *    server resolves them, emits the same events, and the transcript shows
 *    the same entry, tagged with where it came from. A message is edited
 *    when the thing it announced is resolved, whichever side resolved it.
 */

/** One inline button. `data` must round-trip through the channel (Telegram caps it at 64 bytes). */
export interface Button { label: string; data: string }

/** A delivery channel. Never throws; a failed delivery is a lost tap, not a lost run. */
export interface Transport {
  readonly name: string;
  /** Returns an opaque message id if the channel supports editing later. */
  send(text: string, opts?: { buttons?: Button[][] }): Promise<string | null>;
  /** Replaces the text and drops any buttons unless new ones are given. */
  edit(id: string, text: string, opts?: { buttons?: Button[][] }): Promise<void>;
  /** Shows "working" for as long as the returned stop function is not called, where the channel has such a thing. */
  busy?(): () => void;
}

/** The same envelope the SSE clients get, plus the event name. */
export interface Envelope {
  event: string;
  runId: string | null;
  projectId: string;
  chat?: boolean;
  data: Record<string, unknown>;
  ts?: number;
}

/** The three Settings toggles, reused as the channel's filter. */
export interface NotifyPrefs {
  needsYou: boolean;
  done: boolean;
  budget: boolean;
}

export interface NotifyContext {
  prefs: NotifyPrefs;
  /** Where deep links point. A phone cannot open localhost; a LAN or Tailscale URL can. */
  publicUrl: string;
  /** For the message text: the project's name rather than its id. */
  projectName?: (projectId: string) => string | undefined;
  /** The run's title or brief, when known. */
  runLabel?: (runId: string) => string | undefined;
}

/** What the channel can answer, in the shape the server's resolve routes take. */
export type Answer =
  | { kind: 'perm'; id: string; behavior: 'allow' | 'deny' }
  | { kind: 'q'; id: string; text: string }
  | { kind: 'cq'; projectId: string; id: string; answers: Record<string, string> }
  /** A tap on a proposal the planner made from the phone: start it as proposed, or drop it. */
  | { kind: 'proposal'; projectId: string; action: 'start' | 'discard' };

/** How long an identical announcement is suppressed. */
export const DEDUPE_TTL_MS = 60_000;

export function escapeHtml(s: unknown): string { return esc(s); }
const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: unknown, n = 160): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One shaped announcement, or null when the event is not for a human. */
export interface Shaped {
  /** Identity for dedupe and for the edit when it resolves. */
  key: string;
  /** Which preference gates it. */
  gate: keyof NotifyPrefs;
  text: string;
  buttons?: Button[][];
}

interface AskQuestion { question: string; options: Array<{ label: string; hint?: string }>; multi?: boolean }

/**
 * A pending ask the channel may answer. Kept by the hub so a tap can be
 * turned back into the exact call the tab would have made.
 */
interface PendingAsk {
  key: string;
  projectId: string;
  messageId?: string;
  transport?: Transport;
  kind: 'perm' | 'q' | 'cq';
  id: string;
  /** cq only: the questions, the answers collected so far, and which is being shown. */
  questions?: AskQuestion[];
  answers?: Record<string, string>;
  index?: number;
  head?: string;
  /** cq only: head and link, the text a resolution appends to. */
  base?: string;
  /** q only: the director's offered choices, so a tap can be turned back into its label. */
  options?: string[];
}

/** Keyboard for one planner question: one option per row so long labels stay readable. */
function optionRows(askId: string, qi: number, q: AskQuestion): Button[][] {
  return (q.options ?? []).slice(0, 6).map((o, oi) => [{
    label: `${oi + 1}. ${clip(o.label, 40)}${oi === 0 ? ' ★' : ''}`,
    data: `cq|${askId}|${qi}|${oi}`,
  }]);
}

/** Text for a planner question step: which question, its options with hints, progress. */
function cqStep(head: string, qs: AskQuestion[], qi: number, answers: Record<string, string>): string {
  const q = qs[qi];
  const done = qs.slice(0, qi).map((p) => `✓ ${esc(clip(p.question, 60))} → <b>${esc(answers[p.question])}</b>`).join('\n');
  const opts = (q.options ?? []).slice(0, 6).map((o, oi) =>
    `${oi + 1}. <b>${esc(o.label)}</b>${oi === 0 ? ' ★' : ''}${o.hint ? ` — <i>${esc(clip(o.hint, 90))}</i>` : ''}`).join('\n');
  return `${head}${done ? `\n${done}` : ''}\n\n${qs.length > 1 ? `<b>${qi + 1}/${qs.length}</b> · ` : ''}${esc(q.question)}\n${opts}` +
    `\n<i>Tap an option, or reply with your own answer.</i>`;
}

/**
 * Which events reach a human, and what they read.
 *
 * Kept as one function rather than a table so each case can say *why* it is
 * here. Anything not listed is transcript furniture — a tool call, a token
 * count, a heartbeat — and belongs on a screen someone chose to look at.
 */
export function shape(env: Envelope, ctx: NotifyContext): Shaped | null {
  const d = env.data ?? {};
  const project = ctx.projectName?.(env.projectId) ?? env.projectId;
  const link = env.chat || !env.runId
    ? `${ctx.publicUrl}/#/p/${env.projectId}`
    : `${ctx.publicUrl}/#/p/${env.projectId}/r/${env.runId}`;
  const head = (title: string) => `<b>${esc(title)}</b> · ${esc(project)}`;
  const foot = `\n<a href="${esc(link)}">Open in Foreman</a>`;
  const run = env.runId ? (ctx.runLabel?.(env.runId) ?? '') : '';
  const runLine = run ? `\n<i>${esc(clip(run, 90))}</i>` : '';

  switch (env.event) {
    // --- something needs the human -------------------------------------
    case 'permission_request':
      return {
        key: `perm:${d.id}`, gate: 'needsYou',
        text: `${head('Needs you — approval')}${runLine}\n${esc(d.agent)} wants <code>${esc(d.toolName)}</code>` +
          (d.description ? `\n${esc(clip(d.description))}` : '') +
          `\n<i>Auto-denied if unanswered in 10 min.</i>${foot}`,
        // Allow and deny only. "Always" grants a path or a tool for the whole
        // run, and that is a decision for a screen showing what it opens.
        buttons: [[{ label: '✓ Allow', data: `p|${d.id}|allow` }, { label: '✗ Deny', data: `p|${d.id}|deny` }]],
      };
    case 'question': {
      const opts = Array.isArray(d.options) ? (d.options as unknown[]).filter((o): o is string => typeof o === 'string').slice(0, 6) : [];
      const list = opts.length ? '\n' + opts.map((o, i) => `${i + 1}. <b>${esc(clip(o, 80))}</b>${i === 0 ? ' ★' : ''}`).join('\n') : '';
      return {
        key: `q:${d.id}`, gate: 'needsYou',
        text: `${head('Needs you — director asks')}${runLine}\n${esc(clip(d.question, 300))}${list}` +
          `\n<i>${opts.length ? 'Tap an option, or reply with your own answer.' : 'Reply to this message to answer.'} ` +
          `"Decide yourself" if unanswered in 10 min.</i>${foot}`,
        buttons: opts.length
          ? opts.map((o, i) => [{ label: `${i + 1}. ${clip(o, 40)}${i === 0 ? ' ★' : ''}`, data: `q|${d.id}|${i}` }])
          : undefined,
      };
    }
    case 'mission_proposed': {
      // Only for a conversation the phone started: a proposal drafted at the
      // desk has its card on the desk. `via` is stamped by the server.
      if (d.via !== 'telegram') return null;
      const done = Array.isArray(d.doneWhen) ? d.doneWhen as string[] : [];
      const models = [d.directorModel, d.workerModel].filter(Boolean).join(' · ');
      const lines = [
        head('Mission proposed'),
        `\n${esc(clip(String(d.mission ?? ''), 700))}`,
        done.length ? `\n<b>Done when</b>\n${done.slice(0, 6).map((x) => `• ${esc(clip(x, 120))}`).join('\n')}${done.length > 6 ? `\n… ${done.length - 6} more` : ''}` : '',
        `\n<i>cap $${Number(d.budgetUsd ?? 0)}${models ? ` · ${esc(models)}` : ''}${d.browser ? ' · browser on' : ''}</i>`,
      ].filter(Boolean).join('\n');
      return {
        key: `proposal:${env.projectId}`, gate: 'needsYou',
        text: lines + foot,
        buttons: [[{ label: 'Start mission', data: `sp|${env.projectId}` }, { label: 'Discard', data: `dp|${env.projectId}` }]],
      };
    }
    case 'chat_question': {
      const qs = Array.isArray(d.questions) ? d.questions as AskQuestion[] : [];
      if (!qs.length) return null;
      const h = head('Needs you — the planner asks');
      return {
        key: `cq:${d.id}`, gate: 'needsYou',
        text: cqStep(h, qs, 0, {}) + foot,
        buttons: optionRows(String(d.id), 0, qs[0]),
      };
    }

    // --- the crew is in trouble ---------------------------------------
    case 'worker_stalled':
      return { key: `stall:${d.id}:${env.ts ?? ''}`, gate: 'needsYou',
        text: `${head('Worker stalled')}${runLine}\n${esc(clip(d.text))}${foot}` };
    case 'worker_looping':
      return { key: `loop:${d.id}:${env.ts ?? ''}`, gate: 'needsYou',
        text: `${head('Worker looping')}${runLine}\n${esc(clip(d.text))}${foot}` };
    case 'director_looping':
      return { key: `dloop:${env.runId}:${env.ts ?? ''}`, gate: 'needsYou',
        text: `${head('Director looping')}${runLine}\nRepeated <code>${esc(d.toolName)}</code> ${esc(d.count)}× — told to change approach.${foot}` };

    // --- something was decided on the human's behalf -------------------
    case 'permission_timeout':
      return { key: `perm:${d.id}`, gate: 'needsYou',
        text: `${head('Auto-denied (unattended)')}${runLine}\n<code>${esc(d.toolName)}</code> went unanswered; denied and redirected to the workspace.${foot}` };
    case 'question_timeout':
      return { key: `q:${d.id}`, gate: 'needsYou',
        text: `${head('Auto-answered (unattended)')}${runLine}\nThe director was told to decide itself and record why.${foot}` };
    case 'chat_question_timeout':
      return { key: `cq:${d.id}`, gate: 'needsYou',
        text: `${head('Planner proceeded (unattended)')}\nNo answer in 30 min; it is going with its recommendations.${foot}` };

    // --- money and completion -----------------------------------------
    case 'budget_alert':
      return { key: `budget:${env.runId}:${d.level}`, gate: 'budget',
        text: `${head(d.level === 'exceeded' ? 'Budget exceeded — run interrupted'
          : d.level === 'warn' ? 'Budget warning — winding down' : 'Budget cap reached')}${runLine}\n${esc(clip(d.text))}${foot}` };
    case 'budget_stop':
      return { key: `stop:${env.runId}`, gate: 'budget',
        text: `${head('Run winding down')}${runLine}\n${esc(clip(d.reason))}${foot}` };
    case 'mission_done_at_cap':
      return { key: `donecap:${env.runId}`, gate: 'done',
        text: `${head('Done, at the cap')}${runLine}\n${esc(clip(d.text))}${foot}` };
    case 'mission_incomplete':
      return { key: `incomplete:${env.runId}`, gate: 'done',
        text: `${head('Not done')}${runLine}\n${esc(clip(d.text))}${foot}` };
    case 'pull_request': {
      if (d.error || !d.url) return null;
      return { key: `pr:${env.runId}`, gate: 'done',
        text: `${head(d.method === 'gh' ? 'Pull request opened' : 'Branch pushed')}${runLine}\n<a href="${esc(String(d.url))}">${esc(String(d.url))}</a>` };
    }
    case 'service_exposed': {
      // Informational, and worth a tap: the crew put something on the air.
      const url = String(d.url ?? '');
      if (!url) return null;
      return { key: `svc:${env.runId}:${d.port}`, gate: 'done',
        text: `${head(`Service up — ${clip(String(d.label ?? 'service'), 40)}`)}${runLine}\n<a href="${esc(url)}">${esc(url)}</a>` };
    }
    case 'run_finished': {
      const status = String(d.status ?? 'done');
      const title = status === 'done' ? 'Mission done' : status === 'error' ? 'Mission failed' : 'Mission interrupted';
      // A scheduled run says so in its title: nobody pressed start, so the
      // first question a phone raises — "who did this?" — is already answered.
      const sched = d.scheduled
        ? ` · scheduled${d.scheduleName ? ` · ${clip(d.scheduleName, 40)}` : ''}`
        : '';
      return { key: `finished:${env.runId}`, gate: 'done',
        text: `${head(title + sched)}${runLine}${foot}` };
    }
    case 'run_error':
      return { key: `error:${env.runId}:${env.ts ?? ''}`, gate: 'done',
        text: `${head('Mission error')}${runLine}\n${esc(clip(d.error))}${foot}` };

    // --- scheduled missions -------------------------------------------
    case 'schedule_paused': {
      // A paused schedule is the one thing here that stays broken until
      // someone acts, so it says why in plain words. Which toggle carries it
      // follows the cause: the monthly ceiling is a spending guard, repeated
      // failures are a thing only a human can clear. Anything else — a hand
      // on the switch — is news, not a summons.
      const reason = String(d.reason ?? '');
      const gate: keyof NotifyPrefs = reason === 'monthly-cap' ? 'budget' : reason === 'failures' ? 'needsYou' : 'done';
      const why = reason === 'failures'
        ? 'two scheduled runs in a row failed'
        : reason === 'monthly-cap'
          ? "this month's scheduled spend would go past the ceiling"
          : reason === 'human'
            ? 'you paused it'
            : `paused${reason ? ` — ${esc(clip(reason, 60))}` : ''}`;
      return {
        key: `schedule:${d.scheduleId}`, gate,
        // No buttons on purpose: resuming a schedule is a dashboard act, where
        // the cadence, the caps and what it last did are all in view.
        text: `${head('Schedule paused')}\n<b>${esc(clip(d.name, 60))}</b> — ${why}.` +
          `\n<i>Resume it from the Foreman dashboard; there is no resume from here.</i>${foot}`,
      };
    }
    case 'schedule_skipped': {
      // Nothing is wrong and nothing is owed: the cadence simply stepped over
      // a busy project. Keyed by timestamp like a stall, so a run of skips
      // reads as a run of skips rather than one deduped line.
      const reason = String(d.reason ?? '');
      const why = reason === 'project busy'
        ? 'the project already had a mission running, so this turn was not started'
        : `not started${reason ? ` — ${esc(clip(reason, 60))}` : ''}`;
      return {
        key: `skip:${d.scheduleId}:${env.ts ?? ''}`, gate: 'done',
        text: `${head('Scheduled run skipped')}\n<b>${esc(clip(d.name, 60))}</b> — ${why}.` +
          `\n<i>The next scheduled run stands.</i>${foot}`,
      };
    }
    default:
      return null;
  }
}

/**
 * Events that close something announced earlier. The earlier message is
 * edited rather than a new one sent: a phone should show the outcome, not a
 * stale question above the answer to it. Editing also drops the buttons.
 */
export function resolution(env: Envelope): { key: string; suffix: string } | null {
  const d = env.data ?? {};
  const via = d.source ? ` · via ${esc(d.source)}` : '';
  switch (env.event) {
    case 'permission_resolved':
      return { key: `perm:${d.id}`, suffix: `\n\n✓ ${esc(d.behavior ?? 'resolved')}${via}` };
    case 'question_answered':
      return { key: `q:${d.id}`, suffix: `\n\n✓ answered${via}` };
    case 'chat_answered': {
      const a = (d.answers ?? {}) as Record<string, string>;
      const lines = Object.entries(a).map(([q, v]) => `✓ ${esc(clip(q, 60))} → <b>${esc(v)}</b>`).join('\n');
      return { key: `cq:${d.id}`, suffix: `\n\n${lines || '✓ answered'}${via}` };
    }
    default:
      return null;
  }
}

/**
 * The hub: one per server. Attach transports; feed it every envelope; hand
 * it the channel's taps and replies, and it hands back {@link Answer}s.
 *
 * Deliveries are fire-and-forget and never awaited by the emitter — a slow
 * or dead channel must not slow a run. Failures are counted, not thrown.
 */
export class NotifyHub {
  private transports: Transport[] = [];
  private recent = new Map<string, number>();
  /**
   * What was sent, per key. `base` is what a resolution appends to: for a
   * stepped planner question it is the head and the link only, so the
   * finished message reads head → answers → link, not answers under a stale
   * option list from step one.
   */
  private sent = new Map<string, { transport: Transport; id: string; text: string; base?: string }>();
  private pending = new Map<string, PendingAsk>();
  private byMessage = new Map<string, string>(); // messageId -> ask key
  private answerHandler: ((a: Answer) => void) | null = null;
  public failures = 0;
  public delivered = 0;

  constructor(private ctx: () => NotifyContext) {}

  attach(t: Transport): void { this.transports.push(t); }
  /**
   * The channel's "working" indicator, for the whole of a planner turn. A
   * phone that shows nothing for thirty seconds and then a paragraph reads
   * as a bot that ignored you; the typing bubble is the difference.
   */
  busy(): () => void {
    const stops = this.transports.map((t) => t.busy?.()).filter((f): f is () => void => typeof f === 'function');
    return () => { for (const s of stops) s(); };
  }
  detach(name: string): void { this.transports = this.transports.filter((t) => t.name !== name); }
  get active(): string[] { return this.transports.map((t) => t.name); }

  /** The server registers the one function that turns an answer into a resolve. */
  onAnswer(fn: (a: Answer) => void): void { this.answerHandler = fn; }

  /** Called from the broadcaster. Synchronous by design; work happens off the emitter's path. */
  handle(env: Envelope): void {
    if (!this.transports.length) return;
    const res = resolution(env);
    if (res) { void this.resolve(res.key, res.suffix); return; }
    const ctx = this.ctx();
    const s = shape(env, ctx);
    if (!s || !ctx.prefs[s.gate]) return;
    const now = env.ts ?? Date.now();
    const last = this.recent.get(s.key);
    // A permission that times out re-announces under the same key on purpose
    // (the outcome is news); anything else repeating inside the TTL is a
    // re-asking agent, and one tap is enough.
    if (last && now - last < DEDUPE_TTL_MS && !/timeout$/.test(env.event)) return;
    this.recent.set(s.key, now);
    this.remember(env, s);
    void this.deliver(s.key, s.text, s.buttons);
  }

  /** Keep what a tap will need, so the channel never has to know Foreman's routes. */
  private remember(env: Envelope, s: Shaped): void {
    const d = env.data ?? {};
    if (env.event === 'permission_request') {
      this.pending.set(s.key, { key: s.key, projectId: env.projectId, kind: 'perm', id: String(d.id) });
    } else if (env.event === 'question') {
      const options = Array.isArray(d.options) ? (d.options as unknown[]).filter((o): o is string => typeof o === 'string') : undefined;
      this.pending.set(s.key, { key: s.key, projectId: env.projectId, kind: 'q', id: String(d.id), options });
    } else if (env.event === 'chat_question') {
      const qs = d.questions as AskQuestion[];
      const c = this.ctx();
      const project = c.projectName?.(env.projectId) ?? env.projectId;
      const head = `<b>Needs you — the planner asks</b> · ${esc(project)}`;
      const link = `${c.publicUrl}/#/p/${env.projectId}`;
      this.pending.set(s.key, {
        key: s.key, projectId: env.projectId, kind: 'cq', id: String(d.id),
        questions: qs, answers: {}, index: 0, head,
        base: `${head}\n<a href="${esc(link)}">Open in Foreman</a>`,
      });
    } else if (/timeout$/.test(env.event)) {
      this.pending.delete(s.key);
    }
  }

  /**
   * A button was tapped. `data` is what {@link shape} put on the button;
   * anything else — a stale message, a forged payload — is ignored.
   */
  handleCallback(data: string, messageId?: string): boolean {
    const [kind, id, a, b] = data.split('|');
    if (kind === 'sp' || kind === 'dp') {
      this.answerHandler?.({ kind: 'proposal', projectId: id, action: kind === 'sp' ? 'start' : 'discard' });
      return true;
    }
    if (kind === 'p' && (a === 'allow' || a === 'deny')) {
      const ask = this.pending.get(`perm:${id}`);
      if (!ask) return false;
      // Dispatched once. The resolution event that follows still edits the
      // message; a second tap on the same buttons must find nothing to do.
      this.pending.delete(ask.key);
      this.answerHandler?.({ kind: 'perm', id, behavior: a });
      return true;
    }
    if (kind === 'q') {
      // A director question with options: the tap is the label, exactly as
      // typing it would have been.
      const ask = this.pending.get(`q:${id}`);
      const label = ask?.options?.[Number(a)];
      if (!ask || !label) return false;
      this.pending.delete(ask.key);
      this.answerHandler?.({ kind: 'q', id, text: label });
      return true;
    }
    if (kind === 'cq') {
      const ask = this.pending.get(`cq:${id}`);
      if (!ask || !ask.questions || ask.answers === undefined || ask.index === undefined) return false;
      const qi = Number(a), oi = Number(b);
      if (qi !== ask.index) return false; // a tap on an earlier step's buttons
      const q = ask.questions[qi]; const opt = q?.options[oi];
      if (!q || !opt) return false;
      ask.answers[q.question] = opt.label;
      return this.advance(ask, messageId);
    }
    return false;
  }

  /**
   * Free text arrived. A reply to a known message answers that ask; otherwise
   * it answers the one director question pending, or the current step of the
   * one planner question pending — the same "something else" the picker has.
   */
  handleText(text: string, replyToMessageId?: string): boolean {
    const t = text.trim();
    if (!t) return false;
    let ask: PendingAsk | undefined;
    if (replyToMessageId) ask = this.pending.get(this.byMessage.get(replyToMessageId) ?? '');
    if (!ask) {
      const open = [...this.pending.values()].filter((p) => p.kind !== 'perm');
      if (open.length === 1) ask = open[0];
    }
    if (!ask) return false;
    if (ask.kind === 'q') {
      this.pending.delete(ask.key);
      this.answerHandler?.({ kind: 'q', id: ask.id, text: t });
      return true;
    }
    if (ask.kind === 'cq' && ask.questions && ask.answers && ask.index !== undefined) {
      ask.answers[ask.questions[ask.index].question] = t;
      return this.advance(ask, ask.messageId);
    }
    return false;
  }

  /** Next planner question, or the finished answer set. */
  private advance(ask: PendingAsk, messageId?: string): boolean {
    const qs = ask.questions!, answers = ask.answers!;
    ask.index = (ask.index ?? 0) + 1;
    if (ask.index < qs.length) {
      const text = cqStep(ask.head ?? '', qs, ask.index, answers);
      const m = this.sent.get(ask.key);
      const id = messageId ?? m?.id;
      if (m && id) {
        m.text = text; // so a later re-edit (timeout, dedupe) starts from the current step
        void m.transport.edit(id, text, { buttons: optionRows(ask.id, ask.index, qs[ask.index]) }).catch(() => { this.failures++; });
      }
      return true;
    }
    this.pending.delete(ask.key);
    this.answerHandler?.({ kind: 'cq', projectId: ask.projectId, id: ask.id, answers });
    return true;
  }

  private async deliver(key: string, text: string, buttons?: Button[][]): Promise<void> {
    for (const t of this.transports) {
      try {
        const existing = this.sent.get(key);
        if (existing && existing.transport === t) {
          // Same key again (e.g. a timeout on a pending ask): update in place.
          await t.edit(existing.id, text);
          existing.text = text;
        } else {
          const id = await t.send(text, buttons ? { buttons } : undefined);
          if (id) {
            this.sent.set(key, { transport: t, id, text, base: this.pending.get(key)?.base });
            this.byMessage.set(id, key);
            const ask = this.pending.get(key);
            if (ask) { ask.messageId = id; ask.transport = t; }
          }
        }
        this.delivered++;
      } catch { this.failures++; }
    }
    if (this.sent.size > 500) {
      for (const k of [...this.sent.keys()].slice(0, 100)) { this.sent.delete(k); this.pending.delete(k); }
    }
  }

  private async resolve(key: string, suffix: string): Promise<void> {
    this.pending.delete(key);
    const m = this.sent.get(key);
    if (!m) return;
    // Edited without buttons: an answered question offers nothing to tap. A
    // stepped question resolves onto its base — head and link — so the
    // finished message is the answers, not the answers under step one's
    // option list.
    try { await m.transport.edit(m.id, (m.base ?? m.text) + suffix); } catch { this.failures++; }
    this.sent.delete(key);
    this.byMessage.delete(m.id);
  }

  /** Send something outside the event flow — the Settings "test" button, a command's reply, the planner's words. */
  async say(text: string, opts?: { buttons?: Button[][] }): Promise<boolean> {
    let ok = false;
    for (const t of this.transports) {
      try { if (await t.send(text, opts)) ok = true; } catch { this.failures++; }
    }
    return ok;
  }
}
