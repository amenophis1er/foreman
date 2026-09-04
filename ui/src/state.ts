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
};

export type Question = { id: string; question: string };
export type AgentInfo = { id: string; status: Status; task?: string };

/** '' inherits; otherwise an id from GET /models or a full claude-* id. */
export type ModelChoice = string;

/** Pins a project to one Claude Code install; server default when absent. */
export type AuthMode = 'api-key' | 'subscription' | 'cloud' | 'none';

export type ClaudeInstancePin = {
  configDir?: string; executable?: string;
  /** 'own-login' drops the server's API key so the pinned account pays. */
  billing?: 'inherit' | 'own-login';
};

export type RunSummary = {
  id: string; projectId?: string; folder: string; mission: string;
  /** Short generated name; absent until the naming call lands (or fails). */
  title?: string;
  budgetUsd: number; status: Status; costUsd: number;
  createdAt: number; endedAt?: number;
  directorModel?: string; workerModel?: string; resumes?: number;
  browserTools?: boolean;
  directorSessionId?: string;
};

export type ProjectSummary = {
  id: string; name: string; folder: string; createdAt: number;
  claudeInstance?: ClaudeInstancePin;
  /** What this project will actually bill; can differ from the server's mode. */
  billingMode?: AuthMode;
  defaultBudgetUsd: number;
  activeRun: RunSummary | null;
  lastRun: { mission: string; title?: string; status: Status; createdAt?: number; costUsd?: number } | null;
  /** When this project last did anything; the server sorts the fleet by it. */
  lastActivityAt?: number;
  pendingPermissions: number;
  pendingQuestions: number;
};

export type RunView = {
  runStatus: Status;
  mission: string;
  /** Generated mission name, once `run_titled` arrives; '' until then. */
  title: string;
  costUsd: number;
  budgetUsd: number;
  directorSessionId?: string;
  agents: AgentInfo[];
  entries: Entry[];
  approvals: Approval[];
  questions: Question[];
  missionDoc: string | null;
};

const emptyRun: RunView = {
  runStatus: 'idle', mission: '', title: '', costUsd: 0, budgetUsd: 5,
  agents: [], entries: [], approvals: [], questions: [], missionDoc: null,
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

function applyWire(s: RunView, e: WireEvent): RunView {
  const ts = e.ts ?? Date.now();
  const d = e.data;
  switch (e.event) {
    case 'run_started':
      return {
        ...emptyRun, missionDoc: s.missionDoc,
        runStatus: 'running', mission: d.mission, budgetUsd: d.budgetUsd,
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
    case 'run_error':
      return { ...s, entries: [...s.entries, { id: ++seq, ts, agent: 'system', kind: 'error', title: 'error', body: d.error }] };
    case 'run_titled':
      return { ...s, title: String(d.title ?? '') };
    case 'cost':
      return { ...s, costUsd: d.costUsd, budgetUsd: d.budgetUsd };
    case 'message': {
      const extra: Partial<RunView> =
        d.agent === 'director' && d.msg?.session_id ? { directorSessionId: d.msg.session_id } : {};
      const es = entriesFromSdkMessage(d.agent, d.msg, ts);
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
    case 'budget_alert':
      return {
        ...s,
        entries: [...s.entries, {
          id: ++seq, ts, agent: 'system',
          kind: d.level === 'exceeded' ? 'error' : 'system',
          title: 'budget', body: d.text,
        }],
      };
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
    case 'worker_finished':
      return {
        ...s,
        agents: s.agents.map((x) => x.id === d.id ? { ...x, status: d.status as Status } : x),
      };
    case 'permission_request':
      return { ...s, approvals: [...s.approvals, d] };
    case 'permission_resolved':
      return { ...s, approvals: s.approvals.filter((x) => x.id !== d.id) };
    case 'question':
      return { ...s, questions: [...s.questions, d] };
    case 'question_answered':
      return { ...s, questions: s.questions.filter((x) => x.id !== d.id) };
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

  const refresh = useCallback(async () => {
    const r = await fetch('/projects').catch(() => null);
    if (!r?.ok) return;
    const data = await r.json();
    setProjects(data.projects);
    setAuth({ mode: data.authMode ?? 'none', source: data.authSource ?? '', account: data.authAccount ?? undefined });
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 3000);
    const unsubSse = onSse((event, env) => {
      // A planning conversation is not mission activity: its frames share the
      // stream but must never light up an idle card's ticker.
      if (env.chat) return;
      if (['run_started', 'run_resumed', 'run_finished', 'permission_request',
        'permission_resolved', 'question', 'question_answered'].includes(event)) void refresh();
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

  return { projects, connected, auth, refresh, activity };
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
  createdAt: number;
};

export type ChatView = {
  entries: Entry[];
  /** Everything this conversation has cost since it began. */
  costUsd: number;
  /** The current unspent proposal, if the planner has made one. */
  proposal: MissionProposal | null;
  /** A turn is in flight — the planner is reading or writing its reply. */
  thinking: boolean;
};

const emptyChat: ChatView = { entries: [], costUsd: 0, proposal: null, thinking: false };

function applyChatWire(s: ChatView, e: WireEvent): ChatView {
  const ts = e.ts ?? Date.now();
  const d = e.data;
  switch (e.event) {
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
      const es = entriesFromSdkMessage('foreman', d.msg, ts)
        .filter((e) => e.kind === 'text' || e.kind === 'tool');
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
      return { ...s, thinking: d.state === 'thinking' };
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
export function useChat(projectId: string | null): ChatView & {
  send: (text: string) => Promise<string | null>;
  clear: () => Promise<void>;
  dismissProposal: () => void;
} {
  const [state, dispatch] = useReducer(chatReducer, emptyChat);
  const buffer = useRef<WireEvent[] | null>(null);

  const load = useCallback(async (id: string) => {
    const r = await fetch(`/chat?projectId=${encodeURIComponent(id)}`).catch(() => null);
    if (!r?.ok) return null;
    return await r.json() as {
      events: WireEvent[]; costUsd: number; proposal: MissionProposal | null; thinking: boolean;
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

  const clear = useCallback(async () => {
    if (!projectId) return;
    await fetch(`/chat?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' }).catch(() => {});
    dispatch({ t: 'reset' });
  }, [projectId]);

  // Local-only: the human said "not this one" without spending a turn saying
  // so. The server still holds it, and the next proposal replaces it.
  const dismissProposal = useCallback(() => dispatch({ t: 'dismiss' }), []);

  return { ...state, send, clear, dismissProposal };
}

/** Hash router: '#/' → fleet, '#/p/<projectId>' → project view,
 *  '#/p/<projectId>/r/<runId>' → a specific run (survives refresh). */
export function useRoute(): {
  projectId: string | null;
  runId: string | null;
  go: (projectId: string | null) => void;
  goRun: (projectId: string, runId: string | null) => void;
} {
  const parse = () => {
    const m = window.location.hash.match(/^#\/p\/([^/]+)(?:\/r\/([^/]+))?/);
    return {
      projectId: m ? decodeURIComponent(m[1]) : null,
      runId: m?.[2] ? decodeURIComponent(m[2]) : null,
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
  const goRun = useCallback((projectId: string, runId: string | null) => {
    window.location.hash = runId
      ? `#/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(runId)}`
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
  linkProject: (folder: string, name?: string, instance?: ClaudeInstancePin) =>
    post('/projects', {
      folder, name,
      claudeConfigDir: instance?.configDir || undefined,
      claudeExecutable: instance?.executable || undefined,
    }),
  instances: () => fetch('/instances'),
  updateProject: (
    projectId: string,
    patch: {
      claudeConfigDir?: string; claudeExecutable?: string;
      claudeBilling?: 'inherit' | 'own-login';
      defaultBudgetUsd?: number; name?: string;
    },
  ) =>
    fetch(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  unlinkProject: (projectId: string) =>
    fetch(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  run: (projectId: string, mission: string, budgetUsd: number,
    directorModel?: ModelChoice, workerModel?: ModelChoice, browserTools?: boolean) =>
    post('/run', {
      projectId, mission, budgetUsd,
      directorModel: directorModel || undefined,
      workerModel: workerModel || undefined,
      browserTools: browserTools || undefined,
    }),
  resume: (runId: string) =>
    post(`/runs/${encodeURIComponent(runId)}/resume`, {}),
  permission: (id: string, behavior: 'allow' | 'allow_always' | 'deny', message?: string) =>
    post('/permission', { id, behavior, message }),
  answer: (id: string, text: string) => post('/answer', { id, text }),
  steer: (runId: string, text: string) => post('/steer', { runId, text }),
  interrupt: (runId: string) => post('/interrupt', { runId }),
  browse: (path?: string) =>
    fetch('/browse' + (path ? `?path=${encodeURIComponent(path)}` : '')),
  mkdir: (parent: string, name: string) => post('/mkdir', { parent, name }),
  locate: (name: string) => fetch(`/locate?name=${encodeURIComponent(name)}`),
};
