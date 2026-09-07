// Foreman client state.
//
// Two hooks:
//  - useFleet(): the project list with active-run summaries and pending
//    counts — polled, and refreshed eagerly on relevant SSE events.
//  - useRunView(runId, live): one run's full view state. Replays the
//    persisted event log, then (when `live`) applies matching SSE events.
//    The same applyWire() path renders replay and live identically.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { onConnection, onSse, type Envelope } from './sse';

export type Status = 'idle' | 'running' | 'done' | 'error' | 'interrupted';

/**
 * What a run's spend is. Mirrors `CostBasis` in src/types.ts.
 *
 *  - `priced`   — the dollar figure is real; show and cap in dollars.
 *  - `free`     — the operator's own hardware; nothing is charged per token.
 *  - `unpriced` — real spend of an amount nobody here can state.
 *
 * `free` and `unpriced` both hide the dollar figure and must never be shown
 * with the same words: one of them is a reason to go and look at a bill.
 */
export type CostBasis = 'priced' | 'free' | 'unpriced';

/**
 * The basis on a wire payload, tolerating every vintage of it.
 *
 * Events replay from a log that outlives any deploy, so a run recorded before
 * the split arrives carrying only `metered`. That meant "not priceable" —
 * free and unpriced at once — and reads as `unpriced` here for the same
 * reason the server does it: describing real spend as free is the error that
 * costs someone money.
 */
export function basisOf(d: { costBasis?: string; metered?: boolean }): CostBasis {
  if (d.costBasis === 'priced' || d.costBasis === 'free' || d.costBasis === 'unpriced') {
    return d.costBasis;
  }
  return d.metered === false ? 'unpriced' : 'priced';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Entry = {
  id: number;
  ts: number;
  agent: string;
  kind: 'text' | 'tool' | 'result' | 'system' | 'error' | 'steer';
  title: string;
  body: string;
  /** steer entries only: recipient and delivery timing. */
  to?: string;
  timing?: 'next' | 'now';
};

export type Approval = {
  id: string; agent: string; toolName: string; input: unknown;
  title?: string; description?: string; decisionReason?: string;
  /**
   * Present when the ask was raised by the folder boundary: the directory
   * "always" will open for the run. The card relabels its middle button on
   * it, because there "Always" grants a path, not the tool.
   */
  escapedPath?: string;
  /** Envelope ts of the request — the panel shows "waiting 12m" from it. */
  since?: number;
};

/** `options` when the director offered choices — rendered as buttons; typing still works. */
export type Question = { id: string; question: string; options?: string[]; since?: number };
export type AgentInfo = { id: string; status: Status; task?: string };

/** '' inherits; otherwise an id from GET /models or a full claude-* id. */
export type ModelChoice = string;

export type AuthMode =
  | 'api-key' | 'subscription' | 'cloud' | 'none'
  /** Served from this machine — free per token; budgets cap on turns and time. */
  | 'local'
  /** An endpoint Foreman does not price. */
  | 'provider';

/**
 * Who serves a project's models and who pays. One choice, not three settings —
 * see src/provider.ts. The UI reads it; only `claude-code` is settable so far,
 * so the settings form still speaks in config dirs.
 */
export type ProviderRef =
  // `id` is optional on the way out and always present on the way back: the
  // server generates one when a client omits it, and it names that provider's
  // Foreman-owned config dir for the rest of its life.
  | { kind: 'claude-code'; configDir?: string; executable?: string; ownLogin?: boolean }
  | { kind: 'anthropic-api'; id?: string; apiKeyEnv: string; model?: string }
  | { kind: 'codex'; id?: string; codexHome?: string; upstreamUrl?: string; model?: string }
  | { kind: 'openai-compatible'; id?: string; baseUrl: string; apiKeyEnv?: string; label?: string; model?: string };

/** Where this project's agents run, for the "via …" line and the billing source. */
export function providerHome(p?: ProviderRef): string | undefined {
  if (!p) return undefined;
  switch (p.kind) {
    case 'claude-code': return p.configDir;
    case 'codex': return p.codexHome ?? '~/.codex';
    case 'openai-compatible': return p.baseUrl;
    case 'anthropic-api': return `$${p.apiKeyEnv}`;
  }
}

/** Real token counts, unlike the dollar figure beside them. */
export type TokenUsage = {
  inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
};

export type RunSummary = {
  id: string; projectId?: string; folder: string; mission: string;
  /** Short generated name; absent until the naming call lands (or fails). */
  title?: string;
  budgetUsd: number; status: Status; costUsd: number;
  createdAt: number; endedAt?: number;
  directorModel?: string; workerModel?: string; resumes?: number;
  /** The branch this mission ran on, when Foreman gave it one. */
  git?: { branch: string; base: string; baseHead: string | null; commits?: number; commit?: string };
  browserTools?: boolean;
  directorSessionId?: string;
  /** What this run's spend is — see src/types.ts. Absent on older runs. */
  costBasis?: CostBasis;
  /** @deprecated Read `costBasis` through `basisOf()`. */
  metered?: boolean;
  usage?: TokenUsage;
  turns?: number;
};

export type ProjectSummary = {
  id: string; name: string; folder: string; createdAt: number;
  provider?: ProviderRef;
  /** What this project will actually bill; can differ from the server's mode. */
  billingMode?: AuthMode;
  /** What git says about the folder: branch, dirty, remote. `repo: false` for a plain folder. */
  git?: { repo: boolean; branch?: string; dirty?: boolean; head?: string | null; remote?: string };
  defaultBudgetUsd: number;
  activeRun: RunSummary | null;
  lastRun: {
    id?: string;
    mission: string; title?: string; status: Status; createdAt?: number; costUsd?: number;
    /** The card prints a dollar only when this is `priced`; otherwise tokens, or nothing. */
    costBasis?: CostBasis; usage?: TokenUsage;
  } | null;
  /** The planner is parked on a question for this project — counted in pendingQuestions too. */
  plannerQuestion?: boolean;
  /**
   * Every open ask, with enough to answer it from the board. Same ids the
   * tab's cards resolve; for `planner`, `text` is the first question string
   * verbatim, because it is also the answers key.
   */
  needs?: Array<{
    kind: 'permission' | 'question' | 'planner';
    id: string; runId?: string; text: string; options?: string[]; toolName?: string; since?: number;
  }>;
  /** When this project last did anything; the server sorts the fleet by it. */
  lastActivityAt?: number;
  /** Whether a key is on file for this project's provider. Never the key. */
  providerHasKey?: boolean;
  pendingPermissions: number;
  pendingQuestions: number;
};

export type RunView = {
  runStatus: Status;
  mission: string;
  /**
   * What this run's spend is. Through a gateway the SDK prices foreign tokens
   * with Anthropic's table, so a dollar figure is fiction and the meter shows
   * what is true instead — tokens and turns. `unpriced` additionally says the
   * spend is real but untracked, which `free` must never be confused with.
   */
  costBasis: CostBasis;
  usage: TokenUsage | null;
  /** Generated mission name, once `run_titled` arrives; '' until then. */
  title: string;
  costUsd: number;
  budgetUsd: number;
  directorSessionId?: string;
  agents: AgentInfo[];
  /** Dev servers the crew exposed through Foreman (see services.ts on the server). */
  services: Array<{ port: number; label: string; path: string; url?: string; since: number }>;
  entries: Entry[];
  approvals: Approval[];
  questions: Question[];
  missionDoc: string | null;
};

const emptyRun: RunView = {
  runStatus: 'idle', mission: '', title: '', costBasis: 'priced', usage: null, costUsd: 0, budgetUsd: 5,
  agents: [], entries: [], approvals: [], questions: [], missionDoc: null, services: [],
};

// ---------------------------------------------------------------------------
// Wire-event reduction (shared by replay and live)
// ---------------------------------------------------------------------------

type WireEvent = { ts?: number; event: string; data: any };
let seq = 0;

function entriesFromSdkMessage(agent: string, msg: any, ts: number): Entry[] {
  const out: Entry[] = [];
  const push = (kind: Entry['kind'], title: string, body: string) =>
    out.push({ id: ++seq, ts, agent, kind, title, body });

  if (msg.type === 'system' && msg.subtype === 'init') {
    push('system', 'init', `model: ${msg.model ?? '?'}`);
  } else if (msg.type === 'assistant') {
    for (const b of msg.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) push('text', agent, b.text);
      else if (b.type === 'tool_use') {
        const name = String(b.name).replace('mcp__foreman__', '').replace('mcp__playwright__', '');
        // Body must stay valid JSON for the ToolCall chip's diff/pretty view.
        push('tool', name, JSON.stringify(b.input).slice(0, 4000));
      }
    }
  } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content
          : (b.content ?? []).map((x: any) => x.text ?? '').join('');
        push('result', 'result', String(c).slice(0, 700));
      }
    }
  } else if (msg.type === 'result') {
    push(msg.is_error ? 'error' : 'system', `result · ${msg.subtype ?? ''}`,
      String(msg.result ?? '').slice(0, 2500));
  }
  return out;
}

const norm = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();

/**
 * The same words arrived twice in two shapes, and the transcript showed both:
 *
 *  - An agent's end-of-turn `result` carries the text of its last message,
 *    which is already on the page as a rendered card. The result keeps its
 *    place as a turn marker but drops the duplicated body.
 *  - The director learns a worker finished through a tool result that quotes
 *    the worker's whole report, which the worker's own card already shows.
 *    That receipt becomes one line: who finished, and the first sentence.
 *
 * Nothing is lost: the full text is on the card it belongs to, once.
 */
function dedupeEntry(e: Entry, prior: Entry[]): Entry {
  if (e.kind === 'system' && e.title.startsWith('result ·') && e.body) {
    for (let i = prior.length - 1; i >= 0 && i >= prior.length - 40; i--) {
      const p = prior[i];
      if (p.agent !== e.agent) continue;
      if (p.kind === 'text') {
        // Either side may be clipped (results at 2 500 chars, tool payloads
        // shorter), so "the same words" means one is a prefix of the other.
        const a = norm(p.body), b = norm(e.body);
        const same = a.length >= 40 && b.length >= 40 && (a.startsWith(b) || b.startsWith(a));
        return same ? { ...e, body: '' } : e;
      }
    }
    return e;
  }
  if (e.kind === 'result') {
    const m = /^\[(worker-\d+) (finished|failed|done|started|resumed|stalled|interrupted)\]\s*/.exec(e.body);
    if (m) {
      const first = e.body.slice(m[0].length).split('\n').find((l) => l.trim()) ?? '';
      return { ...e, title: `${m[1]} ${m[2]}`, body: first.length > 160 ? `${first.slice(0, 159).trimEnd()}…` : first };
    }
  }
  return e;
}

function applyWire(s: RunView, e: WireEvent): RunView {
  const ts = e.ts ?? Date.now();
  const d = e.data;
  switch (e.event) {
    case 'run_started':
      return {
        ...emptyRun, missionDoc: s.missionDoc,
        runStatus: 'running', mission: d.mission, budgetUsd: d.budgetUsd,
        // Read here rather than waiting for a `cost` event: a run that spends
        // no priceable dollars may never emit one, and the meter would show
        // the previous run's units until it did.
        costBasis: basisOf(d),
        usage: d.usage ?? null,
        agents: [{ id: 'director', status: 'running' }],
      };
    case 'run_resumed': {
      // Workers left "running" by the crash are dead processes; mark them so
      // the tree never shows a phantom spinner (the orchestrator may reuse
      // their ids for genuinely new sessions after rehydration).
      const others = s.agents
        .filter((a) => a.id !== 'director')
        .map((a) => a.status === 'running' ? { ...a, status: 'interrupted' as Status } : a);
      return {
        ...s,
        runStatus: 'running',
        mission: d.mission ?? s.mission,
        budgetUsd: d.budgetUsd ?? s.budgetUsd,
        costUsd: d.costUsd ?? s.costUsd,
        // A resume can legitimately change this: the basis is recomputed at
        // dispatch, so a run wrongly classified by older code heals here.
        costBasis: d.costBasis || d.metered !== undefined ? basisOf(d) : s.costBasis,
        usage: d.usage ?? s.usage,
        agents: [{ id: 'director', status: 'running' as Status }, ...others],
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'system',
          title: 'mission resumed', body: 'Director session restored; re-verifying state against MISSION.md.',
        }],
      };
    }
    case 'run_finished':
      return {
        ...s,
        runStatus: (d.status as Status) || 'done',
        costUsd: d.costUsd ?? s.costUsd,
        approvals: [], questions: [],
        agents: s.agents.map((ag) =>
          ag.id === 'director' ? { ...ag, status: (d.status as Status) || 'done' } : ag),
      };
    case 'mission_incomplete':
      // Sits in the transcript as the reason the run says interrupted rather
      // than done — otherwise the status looks arbitrary next to a director
      // that signed off cleanly.
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'error',
          title: 'not done',
          body: [d.text, '', ...(d.unmet ?? []).map((u: string) => `▢ ${u}`)].join('\n'),
        }],
      };
    case 'run_error':
      return { ...s, entries: [...s.entries, { id: ++seq, ts, agent: 'system', kind: 'error', title: 'error', body: d.error }] };
    case 'worker_stalled':
      // Loud in the transcript on purpose. This exact situation — a worker
      // silent for eight minutes while the director waited inside
      // spawn_worker — looked from the outside like a healthy running
      // mission, because nothing anywhere said otherwise.
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(d.id ?? 'worker'), kind: 'error',
          title: 'worker stalled',
          body: String(d.text ?? 'Worker produced no output and was stopped.'),
        }],
      };
    case 'worker_looping':
      // The stall the silence clock cannot see: the worker was busy, so the
      // meter kept moving, but it was running the same call over and over.
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(d.id ?? 'worker'), kind: 'error',
          title: 'worker looping',
          body: String(d.text ?? `Worker repeated the identical ${String(d.toolName ?? 'tool')} call ${String(d.count ?? '?')} times and was stopped.`),
        }],
      };
    case 'director_looping':
      // The director is notified, not killed, so this may be followed by a
      // recovery — or by a run_error if it loops again after being told.
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'director', kind: 'error',
          title: 'director looping',
          body: String(d.text ?? `Director issued the identical ${String(d.toolName ?? 'tool')} call ${String(d.count ?? '?')} times in a row — notified.`),
        }],
      };
    case 'settings_changed':
      // Recorded in the transcript, not just applied. Foreman is a governance
      // layer: who changed the rules mid-mission, and when, is exactly the
      // kind of thing the run log exists to answer.
      return {
        ...s,
        budgetUsd: typeof d.budgetUsd === 'number' ? d.budgetUsd : s.budgetUsd,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'steer',
          title: 'settings changed',
          body: (d.changes ?? []).join('\n'),
        }],
      };
    case 'run_titled':
      return { ...s, title: String(d.title ?? '') };
    case 'cost':
      return {
        ...s, costUsd: d.costUsd, budgetUsd: d.budgetUsd,
        usage: d.usage ?? s.usage,
        costBasis: basisOf(d),
      };
    case 'message': {
      const extra: Partial<RunView> =
        d.agent === 'director' && d.msg?.session_id ? { directorSessionId: d.msg.session_id } : {};
      const es = entriesFromSdkMessage(d.agent, d.msg, ts).map((e) => dedupeEntry(e, s.entries));
      return es.length || extra.directorSessionId
        ? { ...s, ...extra, entries: [...s.entries.slice(-1499), ...es] } : s;
    }
    case 'steer':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'you', kind: 'steer',
          title: 'steer', body: d.text, to: d.to, timing: d.timing,
        }],
      };
    case 'usage_limit':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'error',
          title: 'usage limit', body: d.text,
        }],
      };
    case 'models_changed':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'system',
          title: 'models changed', body: d.text,
        }],
      };
    case 'git_branch':
    case 'git_note':
    case 'git_committed':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: (e.event === 'git_committed' && d.error) || e.event === 'git_note' ? 'error' : 'system',
          title: e.event === 'git_branch' ? `branch · ${String(d.branch ?? '')}` : e.event === 'git_committed' ? 'branch closed' : 'git',
          body: String(d.text ?? ''),
        }],
      };
    case 'budget_alert':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system',
          kind: d.level === 'exceeded' ? 'error' : 'system',
          title: 'budget', body: d.text,
        }],
      };
    case 'service_exposed':
      return { ...s, services: [...s.services.filter((x) => x.port !== d.port), { port: d.port, label: d.label, path: d.path, url: d.url, since: ts }] };
    case 'worker_started': {
      const rest = s.agents.filter((x) => x.id !== d.id);
      const prev = s.agents.find((x) => x.id === d.id);
      return {
        ...s,
        agents: [...rest, { id: d.id, status: 'running', task: d.task ?? prev?.task }],
        entries: [...s.entries, {
          id: ++seq, ts, agent: d.id, kind: 'system',
          title: d.resumed ? 'resumed' : 'spawned', body: d.task ?? '',
        }],
      };
    }
    case 'worker_progress': {
      // The worker's own account, which the crew tree shows as its current
      // task in place of the brief's first line: once a worker has said where
      // it is, that beats a 200-char echo of what it was asked. Loud enough
      // in the transcript to be found, quiet enough (system, not error) that
      // ten of them do not read as ten problems — a blocker is the one that
      // should stand out, so it gets its own line.
      const status = String(d.status ?? '');
      const body = [
        status,
        ...(Array.isArray(d.done) && d.done.length ? [`done: ${d.done.join(', ')}`] : []),
        ...(d.next ? [`next: ${String(d.next)}`] : []),
        ...(d.blocked ? [`BLOCKED: ${String(d.blocked)}`] : []),
      ].join('\n');
      return {
        ...s,
        agents: s.agents.map((x) => (x.id === d.id ? { ...x, task: status || x.task } : x)),
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(d.id ?? 'worker'), kind: 'system',
          title: d.blocked ? 'progress · blocked' : 'progress', body,
        }],
      };
    }
    case 'worker_finished':
      // Carries `report` too, deliberately not rendered: the worker's own
      // messages already streamed into the transcript, and the report is the
      // director's to read (via check_workers / wait_for_worker). Several
      // workers may be 'running' at once; only this id's entry changes.
      return {
        ...s,
        agents: s.agents.map((x) => x.id === d.id ? { ...x, status: d.status as Status } : x),
      };
    case 'permission_request': {
      // Marked in the transcript, not only queued in the side panel. A run
      // once sat twelve minutes on an unanswered Write approval while the
      // header read `running` and the transcript simply stopped — the ask
      // was on screen, in a rail the human was not watching. "Waiting on a
      // human" is a state of the run and belongs where the eyes are. Guarded
      // by id so a replayed stream does not stamp the same wait twice.
      if (s.approvals.some((x) => x.id === d.id)) return s;
      return {
        ...s,
        approvals: [...s.approvals, { ...d, since: ts }],
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(d.agent ?? 'director'), kind: 'system',
          title: 'waiting on you',
          body: `${String(d.toolName ?? 'tool')}: ${String(d.description ?? d.decisionReason ?? d.title ?? 'needs your approval')}`,
        }],
      };
    }
    case 'permission_resolved': {
      // Only a pending request earns a "resolved" line; a stray or replayed
      // resolution for an id we never showed would otherwise invent a wait.
      const pending = s.approvals.find((x) => x.id === d.id);
      if (!pending) return s;
      return {
        ...s,
        approvals: s.approvals.filter((x) => x.id !== d.id),
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(pending.agent ?? 'director'), kind: 'system',
          title: 'resolved', body: String(d.behavior ?? 'resolved'),
        }],
      };
    }
    case 'question': {
      // Same rule as permission_request: a blocked director is a blocked run.
      if (s.questions.some((x) => x.id === d.id)) return s;
      return {
        ...s,
        questions: [...s.questions, { ...d, since: ts }],
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'director', kind: 'system',
          title: 'waiting on you', body: `question: ${String(d.question ?? '')}`,
        }],
      };
    }
    case 'question_answered': {
      const pending = s.questions.find((x) => x.id === d.id);
      if (!pending) return s;
      return {
        ...s,
        questions: s.questions.filter((x) => x.id !== d.id),
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'director', kind: 'system', title: 'resolved', body: 'answered',
        }],
      };
    }
    case 'root_allowed':
      // The human opened a directory for the run. Recorded because it is a
      // widening of the job site, and the run log is where "who let the
      // mission out of its folder, and to where" must be answerable.
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(d.agent ?? 'director'), kind: 'system',
          title: 'path allowed for run', body: String(d.path ?? ''),
        }],
      };
    case 'auto_denied':
      // A temp-dir write refused without a card. Quiet (system, not error):
      // the agent was told where to go and the next call usually lands there.
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(d.agent ?? 'director'), kind: 'system',
          title: 'redirected to workspace', body: String(d.reason ?? ''),
        }],
      };
    case 'permission_timeout':
    case 'question_timeout': {
      // The unattended default fired. Rendered as `error` — the loud kind —
      // not because anything broke but because a human returning to the run
      // must find, without scrolling for it, that a decision was made in
      // their absence and what it was. Removed from the rail like a normal
      // resolution; guarded by id like one too.
      const isPerm = e.event === 'permission_timeout';
      const pending = isPerm ? s.approvals.find((x) => x.id === d.id) : s.questions.find((x) => x.id === d.id);
      if (!pending) return s;
      const mins = Math.max(1, Math.round(Number(d.afterMs ?? 0) / 60_000));
      return {
        ...s,
        approvals: isPerm ? s.approvals.filter((x) => x.id !== d.id) : s.approvals,
        questions: isPerm ? s.questions : s.questions.filter((x) => x.id !== d.id),
        entries: [...s.entries, {
          id: ++seq, ts, agent: String(d.agent ?? 'director'), kind: 'error',
          title: isPerm ? 'auto-denied (unattended)' : 'auto-answered (unattended)',
          body: isPerm
            ? `${String(d.toolName ?? 'tool')} waited ${mins} min with no answer and was denied; the agent was told to redo the work inside .foreman/work/.`
            : `The director's question waited ${mins} min with no answer; it was told to decide itself and record the decision in MISSION.md.`,
        }],
      };
    }
    default:
      return s;
  }
}

type RunAction =
  | { t: 'reset' }
  | { t: 'wire'; e: WireEvent }
  | { t: 'missiondoc'; doc: string | null };

function runReducer(s: RunView, a: RunAction): RunView {
  switch (a.t) {
    case 'reset': return emptyRun;
    case 'wire': return applyWire(s, a.e);
    case 'missiondoc': return { ...s, missionDoc: a.doc };
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Live view of one run. Replays its log, then follows SSE while `live`. */
export function useRunView(runId: string | null, live: boolean): RunView {
  const [state, dispatch] = useReducer(runReducer, emptyRun);
  // Buffers live events that arrive while the log replay is in flight.
  const buffer = useRef<WireEvent[] | null>(null);

  useEffect(() => {
    dispatch({ t: 'reset' });
    if (!runId) return;
    let cancelled = false;
    buffer.current = [];

    const unsub = live
      ? onSse((event, env: Envelope) => {
          if (env.runId !== runId) return;
          const e: WireEvent = { event, data: env.data };
          if (buffer.current) buffer.current.push(e);
          else dispatch({ t: 'wire', e });
        })
      : null;

    void (async () => {
      try {
        const r = await fetch(`/runs/${encodeURIComponent(runId)}/events`).catch(() => null);
        if (cancelled || !r?.ok) return;
        const { events } = await r.json() as { events: WireEvent[] };
        if (cancelled) return;
        for (const e of events) dispatch({ t: 'wire', e });
      } finally {
        if (!cancelled) {
          for (const e of buffer.current ?? []) dispatch({ t: 'wire', e });
          buffer.current = null;
        }
      }
    })();

    const refreshDoc = async () => {
      const r = await fetch(`/missiondoc?run=${encodeURIComponent(runId)}`).catch(() => null);
      if (r?.ok && !cancelled) dispatch({ t: 'missiondoc', doc: (await r.json()).doc });
    };
    void refreshDoc();
    const docTimer = live ? setInterval(refreshDoc, 5000) : null;

    return () => {
      cancelled = true;
      unsub?.();
      if (docTimer) clearInterval(docTimer);
    };
  }, [runId, live]);

  return state;
}

/** The project list with active runs and pending counts. */
/** One-line summary of a live event, for the fleet card activity ticker. */
function activityLine(event: string, d: any): string | null {
  if (event === 'message') {
    const msg = d.msg;
    if (msg?.type === 'assistant') {
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) return `${d.agent}: ${b.text.trim()}`;
        if (b.type === 'tool_use') {
          const name = String(b.name || '').replace(/^mcp__(foreman|playwright)__/, '');
          return `${d.agent} · ${name}`;
        }
      }
    }
    return null;
  }
  if (event === 'worker_started') return `${d.id} ${d.resumed ? 'resumed' : 'spawned'}`;
  if (event === 'worker_finished') return `${d.id} ${d.status}`;
  if (event === 'worker_progress') return `${d.id}: ${d.blocked ? `BLOCKED — ${d.blocked}` : d.status}`;
  if (event === 'steer') return `you → ${d.to}: ${d.text}`;
  if (event === 'budget_alert') return d.text;
  if (event === 'question') return `director asks: ${d.question}`;
  return null;
}

export function useFleet() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [auth, setAuth] = useState<{ mode: AuthMode; source: string; account?: { email?: string; org?: string } }>(
    { mode: 'none', source: '' });
  /** Latest one-line activity per project, from the live event stream. */
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [update, setUpdate] = useState<{ latest: string; current: string } | null>(null);
  const [version, setVersion] = useState<string>('');

  const refresh = useCallback(async () => {
    const r = await fetch('/projects').catch(() => null);
    if (!r?.ok) return;
    const data = await r.json();
    setProjects(data.projects);
    setAuth({ mode: data.authMode ?? 'none', source: data.authSource ?? '', account: data.authAccount ?? undefined });
    setUpdate(data.update?.latest ? { latest: String(data.update.latest), current: String(data.version ?? '') } : null);
    setVersion(String(data.version ?? ''));
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 3000);
    const unsubSse = onSse((event, env) => {
      // A planning conversation is not mission activity: its frames share the
      // stream but must never light up an idle card's ticker.
      if (env.chat) return;
      if (['run_started', 'run_resumed', 'run_finished', 'permission_request',
        'permission_resolved', 'permission_timeout', 'question', 'question_answered',
        'question_timeout'].includes(event)) void refresh();
      if (env.projectId) {
        if (event === 'run_finished') {
          setActivity((a) => {
            const { [env.projectId]: _gone, ...rest } = a;
            return rest;
          });
        } else {
          const line = activityLine(event, env.data);
          if (line) setActivity((a) => ({ ...a, [env.projectId]: line.slice(0, 160) }));
        }
      }
    });
    const unsubConn = onConnection((up) => {
      setConnected(up);
      if (up) void refresh();
    });
    return () => {
      clearInterval(poll);
      unsubSse();
      unsubConn();
    };
  }, [refresh]);

  return { projects, connected, auth, refresh, activity, update, version };
}

/** Persisted run history for one project, newest first. */
export function useRunHistory(projectId: string) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const refresh = useCallback(async () => {
    const r = await fetch(`/runs?projectId=${encodeURIComponent(projectId)}`).catch(() => null);
    if (r?.ok) setRuns((await r.json()).runs);
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const unsub = onSse((event, env) => {
      if (env.projectId === projectId && (event === 'run_started' || event === 'run_resumed' || event === 'run_finished')) {
        void refresh();
      }
    });
    return unsub;
  }, [projectId, refresh]);
  return runs;
}

// ---------------------------------------------------------------------------
// Planning conversation
// ---------------------------------------------------------------------------

/** A mission the planner drafted, waiting to be started or reworked. */
export type MissionProposal = {
  id: string;
  mission: string;
  doneWhen: string[];
  budgetUsd: number;
  rationale?: string;
  /** The planner judged the criteria need a browser; the card starts with it on. */
  browser?: boolean;
  /** Planner-recommended models, validated server-side; the card pre-selects them. */
  directorModel?: string;
  workerModel?: string;
  directorProviderId?: string;
  workerProviderId?: string;
  /** The planner's one line on why those two, shown beside the pickers. */
  modelRationale?: string;
  createdAt: number;
};

/** One structured question from the planner. Mirrors `AskQuestion` in src/ask.ts. */
export type ChatQuestion = {
  question: string;
  options: Array<{ label: string; hint?: string }>;
  multi?: boolean;
};

/** A batch of questions the planner is parked on, answered together. */
export type ChatAsk = { id: string; questions: ChatQuestion[]; askedAt?: number };

/** Who is answering in this conversation — the thing the chat never showed. */
export type ChatWho = { model: string; provider: string; costBasis: CostBasis };

export type ChatView = {
  entries: Entry[];
  /** Everything this conversation has cost since it began. */
  costUsd: number;
  /** The current unspent proposal, if the planner has made one. */
  proposal: MissionProposal | null;
  /** A turn is in flight — the planner is reading or writing its reply. */
  thinking: boolean;
  /**
   * A question the planner is waiting on. While set, the input box becomes a
   * picker: clicking is faster than typing and the answer comes back exact.
   * Typing still works — the server routes it to the same question.
   */
  question: ChatAsk | null;
  /** Model and provider serving the planner, shown in the bar's footer. */
  who: ChatWho | null;
};

const emptyChat: ChatView = {
  entries: [], costUsd: 0, proposal: null, thinking: false, question: null, who: null,
};

/** "Stack → plain HTML · Imagery → stock photos": what the human chose, for the transcript. */
function summariseAnswers(qs: ChatQuestion[], answers: Record<string, string>): string {
  return qs
    .map((q) => `${q.question.replace(/[?:]\s*$/, '')} → ${answers[q.question] || '(no answer)'}`)
    .join('\n');
}

function applyChatWire(s: ChatView, e: WireEvent): ChatView {
  const ts = e.ts ?? Date.now();
  const d = e.data;
  switch (e.event) {
    // The server threw the conversation away (Clear from another tab, or a
    // fork). Same as the local reset, so a stale proposal cannot outlive it.
    case 'chat_cleared':
      return chatReducer(s, { t: 'reset' });
    // Discarded from the phone: the card goes here too.
    case 'chat_proposal_dismissed':
      return { ...s, proposal: null };
    case 'chat_message':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'you', kind: 'steer', title: 'you', body: d.text,
        }],
      };
    case 'message': {
      // A conversation shows what was said and what was looked at — nothing
      // else. The per-turn `init` banner, the tool results, and the SDK's
      // final `result` (which merely repeats the last assistant message) are
      // mission-transcript furniture; in a chat they read as the machine
      // talking to itself. A failed turn still surfaces, as `chat_error`.
      // ask_user's tool pill is hidden too: the picker is its rendering, and a
      // pill saying "ask_user" above a card full of options says nothing.
      const es = entriesFromSdkMessage('foreman', d.msg, ts)
        .filter((e) => e.kind === 'text' || (e.kind === 'tool' && !/ask_user/.test(e.title)));
      return es.length ? { ...s, entries: [...s.entries, ...es] } : s;
    }
    case 'mission_proposed':
      return { ...s, proposal: d as MissionProposal };
    case 'mission_started':
      return {
        ...s,
        proposal: null,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'system',
          title: 'mission started', body: d.mission,
        }],
      };
    case 'chat_cost':
      return { ...s, costUsd: d.costUsd ?? s.costUsd };
    case 'chat_turn':
      return {
        ...s,
        thinking: d.state === 'thinking',
        // Said on every turn so a change of Settings mid-conversation shows
        // up on the next reply, not after a reload.
        who: typeof d.model === 'string' && typeof d.provider === 'string'
          ? { model: d.model, provider: d.provider, costBasis: basisOf(d) }
          : s.who,
      };
    case 'chat_question':
      // The planner is parked on this until answered. Nothing is appended to
      // the transcript here: the picker IS the rendering, and the answer
      // becomes the transcript entry once it exists.
      return Array.isArray(d.questions) && d.questions.length
        ? { ...s, question: { id: String(d.id), questions: d.questions, askedAt: ts } }
        : s;
    case 'chat_answered': {
      // Recorded as something *you* said, because it is: a click is an answer.
      // The summary form ("Stack → plain HTML") is what the planner also
      // received, so transcript and model agree on what was decided.
      const open = s.question;
      const qs = open && open.id === d.id ? open.questions : [];
      const body = qs.length ? summariseAnswers(qs, d.answers ?? {})
        : Object.entries(d.answers ?? {}).map(([q, a]) => `${q} → ${a}`).join('\n');
      return {
        ...s,
        question: s.question?.id === d.id ? null : s.question,
        entries: body ? [...s.entries, {
          id: ++seq, ts, agent: 'you', kind: 'steer',
          title: d.source ? `you chose · via ${d.source}` : 'you chose', body,
        }] : s.entries,
      };
    }
    case 'chat_question_timeout':
      // Loud, and honest about what happened: the planner went on without an
      // answer, and its next reply states the assumptions it made.
      return {
        ...s,
        question: s.question?.id === d.id ? null : s.question,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'error', title: 'no answer (unattended)',
          body: `No answer after ${Math.round((d.afterMs ?? 0) / 60000)} minutes — the planner ` +
            'is proceeding on its recommended options and will state the assumptions.',
        }],
      };
    case 'chat_error':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system', kind: 'error', title: 'planner', body: d.error,
        }],
      };
    default:
      return s;
  }
}

type ChatAction =
  | { t: 'reset' }
  | { t: 'load'; view: ChatView }
  | { t: 'dismiss' }
  | { t: 'wire'; e: WireEvent };

function chatReducer(s: ChatView, a: ChatAction): ChatView {
  switch (a.t) {
    case 'reset': return emptyChat;
    case 'load': return a.view;
    case 'dismiss': return { ...s, proposal: null };
    case 'wire': return applyChatWire(s, a.e);
  }
}

/**
 * A project's planning conversation. Replays the persisted log, then follows
 * the live stream — the same shape as {@link useRunView}, because a
 * conversation and a mission are the same kind of thing on the wire.
 */
export type RunHit = {
  id: string; projectId: string | null; projectName: string; folder: string; title?: string; mission: string;
  status: 'idle' | 'running' | 'done' | 'error' | 'interrupted'; createdAt: number; endedAt?: number;
  costUsd: number; costBasis: 'priced' | 'free' | 'unpriced';
};

/**
 * Runs across the fleet that answer to the query — the project cards only
 * know their latest run, and "where did we build the seat picker" is a
 * question about all of them. Debounced; an empty or one-letter query asks
 * nothing.
 */
export function useRunSearch(q: string): { hits: RunHit[]; busy: boolean } {
  const [hits, setHits] = useState<RunHit[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.length < 2) { setHits([]); setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      fetch(`/search?q=${encodeURIComponent(q)}`).then((r) => (r.ok ? r.json() : { runs: [] }))
        .then((d: { runs: RunHit[] }) => { if (!cancelled) { setHits(d.runs ?? []); setBusy(false); } })
        .catch(() => { if (!cancelled) { setHits([]); setBusy(false); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);
  return { hits, busy };
}

/** The fleet planner's conversation id on the server — the same chat routes, no project. */
export const FLEET_CHAT_ID = '_fleet';

export function useChat(projectId: string | null): ChatView & {
  send: (text: string) => Promise<string | null>;
  /** Answer the planner's pending question with the picker's choices. */
  answer: (id: string, answers: Record<string, string>) => Promise<string | null>;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  dismissProposal: () => void;
} {
  const [state, dispatch] = useReducer(chatReducer, emptyChat);
  const buffer = useRef<WireEvent[] | null>(null);

  const load = useCallback(async (id: string) => {
    const r = await fetch(`/chat?projectId=${encodeURIComponent(id)}`).catch(() => null);
    if (!r?.ok) return null;
    return await r.json() as {
      events: WireEvent[]; costUsd: number; proposal: MissionProposal | null; thinking: boolean;
      question: ChatAsk | null; who: ChatWho | null;
    };
  }, []);

  useEffect(() => {
    dispatch({ t: 'reset' });
    if (!projectId) return;
    let cancelled = false;
    buffer.current = [];

    const unsub = onSse((event, env) => {
      if (!env.chat || env.projectId !== projectId) return;
      const e: WireEvent = { event, data: env.data };
      if (buffer.current) buffer.current.push(e);
      else dispatch({ t: 'wire', e });
    });

    void (async () => {
      const data = await load(projectId);
      if (cancelled) return;
      if (data) {
        let view: ChatView = {
          ...emptyChat, costUsd: data.costUsd, proposal: data.proposal, thinking: data.thinking,
        };
        for (const e of data.events) view = applyChatWire(view, e);
        // The pending question is server state, not log state: the log holds
        // every question ever asked, and replaying it would resurrect one that
        // was answered or timed out. Only what the server says is still open
        // gets a picker.
        // Likewise whether a reply is in flight: the log can end mid-turn (a
        // restart), and only the server knows if anything is still running.
        view = { ...view, question: data.question ?? null, who: data.who ?? view.who, thinking: data.thinking };
        dispatch({ t: 'load', view });
      }
      // Live frames that arrived during the fetch are applied after it, so a
      // reply landing mid-load is never dropped or shown twice.
      for (const e of buffer.current ?? []) dispatch({ t: 'wire', e });
      buffer.current = null;
    })();

    return () => { cancelled = true; unsub(); };
  }, [projectId, load]);

  const send = useCallback(async (text: string): Promise<string | null> => {
    if (!projectId) return 'no project';
    const r = await post('/chat', { projectId, text });
    return r.ok ? null : ((await r.json().catch(() => ({}))).error ?? 'could not reach the planner');
  }, [projectId]);

  // Stops the reply in flight. The server aborts the model call and closes
  // the turn on the record; the `chat_turn idle` frame is what un-busies the bar.
  const stop = useCallback(async () => {
    if (!projectId) return;
    await post('/chat/stop', { projectId }).catch(() => {});
  }, [projectId]);

  const clear = useCallback(async () => {
    if (!projectId) return;
    await fetch(`/chat?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' }).catch(() => {});
    dispatch({ t: 'reset' });
  }, [projectId]);

  // The picker's answer. The server resolves the tool call and echoes
  // `chat_answered` on the stream, which is what clears the picker here — so
  // a second tab answering the same question clears this one too.
  const answer = useCallback(async (id: string, answers: Record<string, string>): Promise<string | null> => {
    if (!projectId) return 'no project';
    const r = await post('/chat/answer', { projectId, id, answers });
    return r.ok ? null : ((await r.json().catch(() => ({}))).error ?? 'could not deliver the answer');
  }, [projectId]);

  // Local-only: the human said "not this one" without spending a turn saying
  // so. The server still holds it, and the next proposal replaces it.
  const dismissProposal = useCallback(() => dispatch({ t: 'dismiss' }), []);

  return { ...state, send, answer, clear, stop, dismissProposal };
}

/** `GET /notify` — status only; the token is never part of it. Mirrors NotifyPanel.d.ts. */
export type NotifyStatus = {
  publicUrl: string;
  prefs: { needsYou: boolean; done: boolean; budget: boolean };
  active: string[];
  delivered: number;
  failures: number;
  telegram: {
    hasToken: boolean; bot: string | null; chatId: string | null; chatLabel: string | null;
    linking: { code: string; startedAt: number; deepLink?: string } | null;
  };
};

/**
 * Settings → Notifications: the channel's status and the handful of actions
 * on it. Polls while a linking attempt is open, because the answer arrives
 * out of band — the human sends a code to their bot from a phone, and the
 * server notices; nothing in this tab is told directly.
 */
export function useNotify(): {
  status: NotifyStatus | null; busy: boolean; error: string;
  refresh: () => Promise<void>;
  onSaveToken: (token: string) => void; onClearToken: () => void;
  onLink: () => void; onUnlink: () => void; onTest: () => void;
  onSavePublicUrl: (url: string) => void;
} {
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const r = await fetch('/notify').catch(() => null);
    if (r?.ok) setStatus(await r.json() as NotifyStatus);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Linking resolves on the server when the phone message arrives; poll
  // until it does, then stop — the tab has no other way to learn it.
  useEffect(() => {
    if (!status?.telegram.linking) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [status?.telegram.linking, refresh]);

  const act = useCallback(async (req: () => Promise<Response>) => {
    setBusy(true); setError('');
    try {
      const r = await req();
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  const send = (method: string, url: string, body?: unknown) => fetch(url, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  return {
    status, busy, error, refresh,
    onSaveToken: (token) => void act(() => send('PUT', '/notify/telegram/token', { token })),
    onClearToken: () => void act(() => send('DELETE', '/notify/telegram/token')),
    onLink: () => void act(() => send('POST', '/notify/telegram/link')),
    onUnlink: () => void act(() => send('DELETE', '/notify/telegram/link')),
    onTest: () => void act(() => send('POST', '/notify/test')),
    onSavePublicUrl: (publicUrl) => void act(() => send('PATCH', '/notify/settings', { publicUrl })),
  };
}

export type RailTab = 'mission' | 'files' | 'runs';

/** Hash router: '#/' → fleet, '#/p/<projectId>' → project view,
 *  '#/p/<projectId>/r/<runId>' → a specific run, '…/r/<runId>/files' and
 *  '…/runs' → its Files / Runs tab (Mission is the default, no suffix). All survive
 *  refresh and can be sent as links. */
export function useRoute(): {
  projectId: string | null;
  runId: string | null;
  tab: RailTab;
  go: (projectId: string | null) => void;
  goRun: (projectId: string, runId: string | null, tab?: RailTab) => void;
} {
  const parse = () => {
    const m = window.location.hash.match(/^#\/p\/([^/]+)(?:\/r\/([^/]+)(?:\/(files|runs))?)?/);
    return {
      projectId: m ? decodeURIComponent(m[1]) : null,
      runId: m?.[2] ? decodeURIComponent(m[2]) : null,
      tab: (m?.[3] === 'files' || m?.[3] === 'runs' ? m[3] : 'mission') as RailTab,
    };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((id: string | null) => {
    window.location.hash = id ? `#/p/${encodeURIComponent(id)}` : '#/';
  }, []);
  const goRun = useCallback((projectId: string, runId: string | null, tab: RailTab = 'mission') => {
    window.location.hash = runId
      ? `#/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(runId)}${tab === 'mission' ? '' : `/${tab}`}`
      : `#/p/${encodeURIComponent(projectId)}`;
  }, []);
  return { ...route, go, goRun };
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const api = {
  linkProject: (folder: string, name?: string, provider?: ProviderRef) =>
    post('/projects', { folder, name, provider }),
  /** Clone a Git URL under the projects root and link it; returns a job id to poll. */
  cloneProject: (url: string, branch?: string) => post('/projects/clone', { url, branch }),
  cloneStatus: (id: string) => fetch(`/projects/clone/${encodeURIComponent(id)}`),
  /** Where a URL would be cloned, or why it cannot be. */
  cloneWhere: (url: string) => fetch(`/projects/clone/where?url=${encodeURIComponent(url)}`),
  instances: () => fetch('/instances'),
  updateProject: (
    projectId: string,
    patch: {
      /** A whole provider, or `null` to clear the pin back to the server default. */
      provider?: ProviderRef | null;
      defaultBudgetUsd?: number; name?: string;
    },
  ) =>
    fetch(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  unlinkProject: (projectId: string) =>
    fetch(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  run: (projectId: string, mission: string, budgetUsd: number, opts: {
    directorModel?: ModelChoice; workerModel?: ModelChoice;
    /** Where each role runs, from the picked model. Absent = the project's provider. */
    directorProviderId?: string; workerProviderId?: string;
    browserTools?: boolean;
  } = {}) =>
    post('/run', {
      projectId, mission, budgetUsd,
      directorModel: opts.directorModel || undefined,
      workerModel: opts.workerModel || undefined,
      directorProviderId: opts.directorProviderId || undefined,
      workerProviderId: opts.workerProviderId || undefined,
      browserTools: opts.browserTools || undefined,
    }),
  /** Resume; `on` names models for this resume ("Resume on…"), ahead of Settings. */
  resume: (runId: string, on: { directorModel?: string; directorProviderId?: string; workerModel?: string; workerProviderId?: string } = {}) =>
    post(`/runs/${encodeURIComponent(runId)}/resume`, on),
  permission: (id: string, behavior: 'allow' | 'allow_always' | 'deny', message?: string) =>
    post('/permission', { id, behavior, message }),
  answer: (id: string, text: string) => post('/answer', { id, text }),
  /** Saves files into the project folder; returns their project-relative paths. */
  attach: async (projectId: string, files: File[]) => {
    const encoded = await Promise.all(files.map(async (f) => ({
      name: f.name, type: f.type,
      data: await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(r.error);
        r.readAsDataURL(f);
      }),
    })));
    return post('/attachments', { projectId, files: encoded });
  },
  /** Opens a new planning conversation seeded with a finished run. */
  forkPlan: (projectId: string, runId: string) => post('/chat/fork', { projectId, runId }),
  steer: (runId: string, text: string) => post('/steer', { runId, text }),
  interrupt: (runId: string) => post('/interrupt', { runId }),
  /**
   * Change a live run's settings. Only the fields that genuinely bind
   * mid-run are accepted — the server rejects anything else rather than
   * appearing to apply it.
   */
  updateRun: (runId: string, patch: { browserTools?: boolean; budgetUsd?: number }) =>
    fetch('/run', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, ...patch }),
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ changes: string[] }>;
    }),
  /** Stores a provider's key. There is no read counterpart, by design. */
  setProviderKey: (providerId: string, key: string) =>
    fetch(`/providers/${encodeURIComponent(providerId)}/key`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }),
  clearProviderKey: (providerId: string) =>
    fetch(`/providers/${encodeURIComponent(providerId)}/key`, { method: 'DELETE' }),
  browse: (path?: string) =>
    fetch('/browse' + (path ? `?path=${encodeURIComponent(path)}` : '')),
  mkdir: (parent: string, name: string) => post('/mkdir', { parent, name }),
  locate: (name: string) => fetch(`/locate?name=${encodeURIComponent(name)}`),
};

/**
 * Uploads a message's files and returns the text with their paths appended,
 * so the reader — planner or director — knows what came with it. Throws the
 * server's message when a file is refused, so the caller can show it.
 */
export async function withAttachments(projectId: string, text: string, files: File[]): Promise<string> {
  if (!files.length) return text;
  const r = await api.attach(projectId, files);
  const body = (await r.json().catch(() => ({}))) as { error?: string; files?: { path: string }[] };
  if (!r.ok) throw new Error(body.error || 'could not save the attachments');
  const paths = (body.files ?? []).map((f: { path: string }) => f.path);
  return `${text}\n\nAttached files (in the project folder — read them):\n${paths.map((q: string) => `- ${q}`).join('\n')}`;
}
