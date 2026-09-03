// Foreman client state.
//
// One code path applies events everywhere: the SSE stream (live), the latest
// run's persisted log (hydration on page load), and any historical run the
// user opens (read-only replay). This guarantees a replayed run renders
// exactly like it did live.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Status } from './design/ui';

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

export type RunSummary = {
  id: string; folder: string; mission: string; budgetUsd: number;
  status: Status; costUsd: number; createdAt: number; endedAt?: number;
};

export type State = {
  connected: boolean;
  runStatus: Status;
  folder: string;
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

const initial: State = {
  connected: false, runStatus: 'idle', folder: '', mission: '',
  costUsd: 0, budgetUsd: 5, agents: [], entries: [],
  approvals: [], questions: [], missionDoc: null,
};

type WireEvent = { ts?: number; event: string; data: any };

type Action =
  | { t: 'connected'; v: boolean }
  | { t: 'reset' }
  | { t: 'wire'; e: WireEvent }
  | { t: 'missiondoc'; doc: string | null };

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

/** Applies one wire event (live or replayed) to the state. */
function applyWire(s: State, e: WireEvent): State {
  const ts = e.ts ?? Date.now();
  const d = e.data;
  switch (e.event) {
    case 'run_started':
      return {
        ...initial, connected: s.connected, missionDoc: s.missionDoc,
        runStatus: 'running', folder: d.folder, mission: d.mission, budgetUsd: d.budgetUsd,
        agents: [{ id: 'director', status: 'running' }],
      };
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
    case 'folder_created':
      return { ...s, entries: [...s.entries, { id: ++seq, ts, agent: 'system', kind: 'system', title: 'folder created', body: d.folder }] };
    case 'cost':
      return { ...s, costUsd: d.costUsd, budgetUsd: d.budgetUsd };
    case 'message': {
      const extra: Partial<State> =
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

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'connected': return { ...s, connected: a.v };
    case 'reset': return { ...initial, connected: s.connected };
    case 'wire': return applyWire(s, a.e);
    case 'missiondoc': return { ...s, missionDoc: a.doc };
  }
}

export type ViewMode =
  | { kind: 'live' }
  | { kind: 'history'; runId: string };

export function useForeman() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [mode, setMode] = useState<ViewMode>({ kind: 'live' });
  const modeRef = useRef<ViewMode>(mode);
  modeRef.current = mode;
  const docTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Live events arriving while hydration replays the persisted log are
  // buffered, then flushed, so nothing is lost or double-applied out of order.
  const buffer = useRef<WireEvent[] | null>([]);

  const refreshRuns = useCallback(async () => {
    const r = await fetch('/runs').catch(() => null);
    if (r?.ok) setRuns((await r.json()).runs);
  }, []);

  const refreshDoc = useCallback(async (runId?: string) => {
    const q = runId ? `?run=${encodeURIComponent(runId)}` : '';
    const r = await fetch('/missiondoc' + q).catch(() => null);
    if (r?.ok) dispatch({ t: 'missiondoc', doc: (await r.json()).doc });
  }, []);

  const replayRun = useCallback(async (runId: string) => {
    const r = await fetch(`/runs/${encodeURIComponent(runId)}/events`).catch(() => null);
    if (!r?.ok) return false;
    const { events } = await r.json() as { events: WireEvent[] };
    dispatch({ t: 'reset' });
    for (const e of events) dispatch({ t: 'wire', e });
    void refreshDoc(runId);
    return true;
  }, [refreshDoc]);

  /** Open a past run read-only. */
  const viewRun = useCallback(async (runId: string) => {
    setMode({ kind: 'history', runId });
    await replayRun(runId);
  }, [replayRun]);

  /** Return to the live view (replaying the newest run's log first). */
  const backToLive = useCallback(async () => {
    setMode({ kind: 'live' });
    const r = await fetch('/runs').catch(() => null);
    const latest: RunSummary | undefined = r?.ok ? (await r.json()).runs[0] : undefined;
    dispatch({ t: 'reset' });
    if (latest) await replayRun(latest.id);
  }, [replayRun]);

  useEffect(() => {
    const es = new EventSource('/events');
    es.onopen = () => dispatch({ t: 'connected', v: true });
    es.onerror = () => dispatch({ t: 'connected', v: false });

    const EVENTS = [
      'run_started', 'run_finished', 'run_error', 'folder_created', 'cost',
      'message', 'worker_started', 'worker_finished',
      'permission_request', 'permission_resolved', 'question', 'question_answered',
    ];
    for (const name of EVENTS) {
      es.addEventListener(name, (raw) => {
        const e: WireEvent = { event: name, data: JSON.parse((raw as MessageEvent).data) };
        if (name === 'run_started' || name === 'run_finished') void refreshRuns();
        if (name === 'run_started' && modeRef.current.kind === 'history') {
          // A new mission started while browsing history — jump back to live.
          setMode({ kind: 'live' });
          buffer.current = null;
        }
        if (modeRef.current.kind === 'history') return; // read-only view
        if (buffer.current) buffer.current.push(e);
        else dispatch({ t: 'wire', e });
      });
    }

    // Hydrate: replay the newest persisted run, then flush buffered live events.
    void (async () => {
      try {
        const r = await fetch('/runs').catch(() => null);
        const all: RunSummary[] = r?.ok ? ((await r.json()).runs ?? []) : [];
        setRuns(all);
        if (all[0]) await replayRun(all[0].id);
      } finally {
        const pending = buffer.current ?? [];
        buffer.current = null;
        for (const e of pending) dispatch({ t: 'wire', e });
      }
    })();

    docTimer.current = setInterval(() => {
      if (modeRef.current.kind === 'live') void refreshDoc();
    }, 5000);

    return () => {
      es.close();
      if (docTimer.current) clearInterval(docTimer.current);
    };
  }, [refreshRuns, refreshDoc, replayRun]);

  return { state, runs, mode, viewRun, backToLive };
}

export const api = {
  run: (folder: string, mission: string, budgetUsd: number) =>
    fetch('/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder, mission, budgetUsd }),
    }),
  permission: (id: string, behavior: 'allow' | 'allow_always' | 'deny', message?: string) =>
    fetch('/permission', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, behavior, message }),
    }),
  answer: (id: string, text: string) =>
    fetch('/answer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, text }),
    }),
  interrupt: () => fetch('/interrupt', { method: 'POST' }),
  browse: (path?: string) =>
    fetch('/browse' + (path ? `?path=${encodeURIComponent(path)}` : '')),
};
