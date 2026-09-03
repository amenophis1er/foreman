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
import type { Status } from './design/ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Entry = {
  id: number;
  ts: number;
  agent: string;
  kind: 'text' | 'tool' | 'result' | 'system' | 'error';
  title: string;
  body: string;
};

export type Approval = {
  id: string; agent: string; toolName: string; input: unknown;
  title?: string; description?: string; decisionReason?: string;
};

export type Question = { id: string; question: string };
export type AgentInfo = { id: string; status: Status; task?: string };

export type ModelChoice = 'opus' | 'sonnet' | 'haiku' | '';

export type RunSummary = {
  id: string; projectId?: string; folder: string; mission: string;
  budgetUsd: number; status: Status; costUsd: number;
  createdAt: number; endedAt?: number;
  directorModel?: string; workerModel?: string; resumes?: number;
  directorSessionId?: string;
};

export type ProjectSummary = {
  id: string; name: string; folder: string; createdAt: number;
  defaultBudgetUsd: number;
  activeRun: RunSummary | null;
  pendingPermissions: number;
  pendingQuestions: number;
};

export type RunView = {
  runStatus: Status;
  mission: string;
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
  runStatus: 'idle', mission: '', costUsd: 0, budgetUsd: 5,
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
        push('tool', String(b.name).replace('mcp__foreman__', '⚙ '),
          JSON.stringify(b.input).slice(0, 500));
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
    case 'cost':
      return { ...s, costUsd: d.costUsd, budgetUsd: d.budgetUsd };
    case 'message': {
      const extra: Partial<RunView> =
        d.agent === 'director' && d.msg?.session_id ? { directorSessionId: d.msg.session_id } : {};
      const es = entriesFromSdkMessage(d.agent, d.msg, ts);
      return es.length || extra.directorSessionId
        ? { ...s, ...extra, entries: [...s.entries.slice(-1499), ...es] } : s;
    }
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
export function useFleet() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch('/projects').catch(() => null);
    if (r?.ok) setProjects((await r.json()).projects);
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 3000);
    const unsubSse = onSse((event) => {
      if (['run_started', 'run_resumed', 'run_finished', 'permission_request',
        'permission_resolved', 'question', 'question_answered'].includes(event)) void refresh();
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

  return { projects, connected, refresh };
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

/** Hash router: '#/' → fleet, '#/p/<projectId>' → project view. */
export function useRoute(): { projectId: string | null; go: (projectId: string | null) => void } {
  const parse = () => {
    const m = window.location.hash.match(/^#\/p\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const [projectId, setProjectId] = useState<string | null>(parse);
  useEffect(() => {
    const onHash = () => setProjectId(parse());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((id: string | null) => {
    window.location.hash = id ? `#/p/${encodeURIComponent(id)}` : '#/';
  }, []);
  return { projectId, go };
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
  linkProject: (folder: string, name?: string) => post('/projects', { folder, name }),
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
  interrupt: (runId: string) => post('/interrupt', { runId }),
  browse: (path?: string) =>
    fetch('/browse' + (path ? `?path=${encodeURIComponent(path)}` : '')),
  mkdir: (parent: string, name: string) => post('/mkdir', { parent, name }),
  locate: (name: string) => fetch(`/locate?name=${encodeURIComponent(name)}`),
};
