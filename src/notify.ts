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
 *  - **Never a second answer pipeline.** Phase A only notifies; a message is
 *    edited when the thing it announced is resolved, so a phone shows the
 *    outcome, not a stale question. Answering from the channel (Phase B) will
 *    go through the exact routes the picker uses.
 */

/** A delivery channel. Never throws; a failed delivery is a lost tap, not a lost run. */
export interface Transport {
  readonly name: string;
  /** Returns an opaque message id if the channel supports editing later. */
  send(text: string): Promise<string | null>;
  edit(id: string, text: string): Promise<void>;
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

/** How long an identical announcement is suppressed. */
export const DEDUPE_TTL_MS = 60_000;

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
      };
    case 'question':
      return {
        key: `q:${d.id}`, gate: 'needsYou',
        text: `${head('Needs you — director asks')}${runLine}\n${esc(clip(d.question, 300))}` +
          `\n<i>Answered "decide yourself" if unanswered in 10 min.</i>${foot}`,
      };
    case 'chat_question': {
      const qs = Array.isArray(d.questions) ? d.questions as Array<{ question: string }> : [];
      return {
        key: `cq:${d.id}`, gate: 'needsYou',
        text: `${head('Needs you — the planner asks')}\n` +
          qs.map((q, i) => `${i + 1}. ${esc(clip(q.question, 120))}`).join('\n') + foot,
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
        text: `${head(d.level === 'exceeded' ? 'Budget exceeded — run interrupted' : 'Budget cap reached')}${runLine}\n${esc(clip(d.text))}${foot}` };
    case 'budget_stop':
      return { key: `stop:${env.runId}`, gate: 'budget',
        text: `${head('Run winding down')}${runLine}\n${esc(clip(d.reason))}${foot}` };
    case 'mission_incomplete':
      return { key: `incomplete:${env.runId}`, gate: 'done',
        text: `${head('Not done')}${runLine}\n${esc(clip(d.text))}${foot}` };
    case 'run_finished': {
      const status = String(d.status ?? 'done');
      const title = status === 'done' ? 'Mission done' : status === 'error' ? 'Mission failed' : 'Mission interrupted';
      return { key: `finished:${env.runId}`, gate: 'done',
        text: `${head(title)}${runLine}${foot}` };
    }
    case 'run_error':
      return { key: `error:${env.runId}:${env.ts ?? ''}`, gate: 'done',
        text: `${head('Mission error')}${runLine}\n${esc(clip(d.error))}${foot}` };
    default:
      return null;
  }
}

/**
 * Events that close something announced earlier. The earlier message is
 * edited rather than a new one sent: a phone should show the outcome, not a
 * stale question above the answer to it.
 */
export function resolution(env: Envelope): { key: string; suffix: string } | null {
  const d = env.data ?? {};
  switch (env.event) {
    case 'permission_resolved':
      return { key: `perm:${d.id}`, suffix: `\n\n✓ ${esc(d.behavior ?? 'resolved')}` };
    case 'question_answered':
      return { key: `q:${d.id}`, suffix: '\n\n✓ answered' };
    case 'chat_answered':
      return { key: `cq:${d.id}`, suffix: '\n\n✓ answered' };
    default:
      return null;
  }
}

/**
 * The hub: one per server. Attach transports; feed it every envelope.
 *
 * Deliveries are fire-and-forget and never awaited by the emitter — a slow
 * or dead channel must not slow a run. Failures are counted, not thrown.
 */
export class NotifyHub {
  private transports: Transport[] = [];
  private recent = new Map<string, number>();
  private sent = new Map<string, { transport: Transport; id: string; text: string }>();
  public failures = 0;
  public delivered = 0;

  constructor(private ctx: () => NotifyContext) {}

  attach(t: Transport): void { this.transports.push(t); }
  detach(name: string): void { this.transports = this.transports.filter((t) => t.name !== name); }
  get active(): string[] { return this.transports.map((t) => t.name); }

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
    void this.deliver(s.key, s.text);
  }

  private async deliver(key: string, text: string): Promise<void> {
    for (const t of this.transports) {
      try {
        const existing = this.sent.get(key);
        if (existing && existing.transport === t) {
          // Same key again (e.g. a timeout on a pending ask): update in place.
          await t.edit(existing.id, text);
          existing.text = text;
        } else {
          const id = await t.send(text);
          if (id) this.sent.set(key, { transport: t, id, text });
        }
        this.delivered++;
      } catch { this.failures++; }
    }
    if (this.sent.size > 500) {
      for (const k of [...this.sent.keys()].slice(0, 100)) this.sent.delete(k);
    }
  }

  private async resolve(key: string, suffix: string): Promise<void> {
    const m = this.sent.get(key);
    if (!m) return;
    try { await m.transport.edit(m.id, m.text + suffix); } catch { this.failures++; }
    this.sent.delete(key);
  }

  /** Send something outside the event flow — the Settings "test" button. */
  async say(text: string): Promise<boolean> {
    let ok = false;
    for (const t of this.transports) {
      try { if (await t.send(text)) ok = true; } catch { this.failures++; }
    }
    return ok;
  }
}
