// Foreman client state: one SSE connection reduced into a store.
import { useEffect, useReducer, useRef } from 'react';
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

type Action =
  | { t: 'connected'; v: boolean }
  | { t: 'run_started'; folder: string; mission: string; budgetUsd: number }
  | { t: 'run_finished'; status: string; costUsd?: number }
  | { t: 'cost'; costUsd: number; budgetUsd: number }
  | { t: 'entry'; e: Omit<Entry, 'id' | 'ts'> }
  | { t: 'worker'; id: string; status: Status; task?: string }
  | { t: 'director_session'; id: string }
  | { t: 'approval_add'; a: Approval }
  | { t: 'approval_remove'; id: string }
  | { t: 'question_add'; q: Question }
  | { t: 'question_remove'; id: string }
  | { t: 'missiondoc'; doc: string | null };

let seq = 0;

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'connected': return { ...s, connected: a.v };
    case 'run_started':
      return {
        ...initial, connected: s.connected,
        runStatus: 'running', folder: a.folder, mission: a.mission, budgetUsd: a.budgetUsd,
        agents: [{ id: 'director', status: 'running' }],
      };
    case 'run_finished':
      return {
        ...s,
        runStatus: (a.status as Status) || 'done',
        costUsd: a.costUsd ?? s.costUsd,
        agents: s.agents.map((ag) =>
          ag.id === 'director' ? { ...ag, status: (a.status as Status) || 'done' } : ag),
      };
    case 'cost': return { ...s, costUsd: a.costUsd, budgetUsd: a.budgetUsd };
    case 'entry':
      return { ...s, entries: [...s.entries.slice(-999), { ...a.e, id: ++seq, ts: Date.now() }] };
    case 'worker': {
      const rest = s.agents.filter((x) => x.id !== a.id);
      const prev = s.agents.find((x) => x.id === a.id);
      return { ...s, agents: [...rest, { id: a.id, status: a.status, task: a.task ?? prev?.task }] };
    }
    case 'director_session': return { ...s, directorSessionId: a.id };
    case 'approval_add': return { ...s, approvals: [...s.approvals, a.a] };
    case 'approval_remove': return { ...s, approvals: s.approvals.filter((x) => x.id !== a.id) };
    case 'question_add': return { ...s, questions: [...s.questions, a.q] };
    case 'question_remove': return { ...s, questions: s.questions.filter((x) => x.id !== a.id) };
    case 'missiondoc': return { ...s, missionDoc: a.doc };
  }
}

function entriesFromSdkMessage(agent: string, msg: any): Omit<Entry, 'id' | 'ts'>[] {
  const out: Omit<Entry, 'id' | 'ts'>[] = [];
  if (msg.type === 'system' && msg.subtype === 'init') {
    out.push({ agent, kind: 'system', title: 'init', body: `model: ${msg.model ?? '?'}` });
  } else if (msg.type === 'assistant') {
    for (const b of msg.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) {
        out.push({ agent, kind: 'text', title: agent, body: b.text });
      } else if (b.type === 'tool_use') {
        out.push({
          agent, kind: 'tool',
          title: String(b.name).replace('mcp__foreman__', '⚙ '),
          body: JSON.stringify(b.input).slice(0, 500),
        });
      }
    }
  } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content
          : (b.content ?? []).map((x: any) => x.text ?? '').join('');
        out.push({ agent, kind: 'result', title: 'result', body: String(c).slice(0, 700) });
      }
    }
  } else if (msg.type === 'result') {
    out.push({
      agent, kind: msg.is_error ? 'error' : 'system',
      title: `result · ${msg.subtype ?? ''}`,
      body: String(msg.result ?? '').slice(0, 2500),
    });
  }
  return out;
}

export function useForeman() {
  const [state, dispatch] = useReducer(reducer, initial);
  const docTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const refreshDoc = async () => {
      const r = await fetch('/missiondoc').catch(() => null);
      if (r?.ok) {
        const d = await r.json();
        dispatch({ t: 'missiondoc', doc: d.doc });
      }
    };

    const es = new EventSource('/events');
    es.onopen = () => dispatch({ t: 'connected', v: true });
    es.onerror = () => dispatch({ t: 'connected', v: false });

    const on = (ev: string, fn: (d: any) => void) =>
      es.addEventListener(ev, (e) => fn(JSON.parse((e as MessageEvent).data)));

    on('run_started', (d) => {
      dispatch({ t: 'run_started', ...d });
      if (docTimer.current) clearInterval(docTimer.current);
      docTimer.current = setInterval(refreshDoc, 5000);
    });
    on('run_finished', (d) => {
      dispatch({ t: 'run_finished', ...d });
      if (docTimer.current) clearInterval(docTimer.current);
      void refreshDoc();
    });
    on('run_error', (d) => dispatch({ t: 'entry', e: { agent: 'system', kind: 'error', title: 'error', body: d.error } }));
    on('folder_created', (d) => dispatch({ t: 'entry', e: { agent: 'system', kind: 'system', title: 'folder created', body: d.folder } }));
    on('cost', (d) => dispatch({ t: 'cost', ...d }));
    on('message', (d) => {
      if (d.agent === 'director' && d.msg?.session_id) dispatch({ t: 'director_session', id: d.msg.session_id });
      for (const e of entriesFromSdkMessage(d.agent, d.msg)) dispatch({ t: 'entry', e });
    });
    on('worker_started', (d) => {
      dispatch({ t: 'worker', id: d.id, status: 'running', task: d.task });
      dispatch({ t: 'entry', e: { agent: d.id, kind: 'system', title: d.resumed ? 'resumed' : 'spawned', body: d.task ?? '' } });
    });
    on('worker_finished', (d) => dispatch({ t: 'worker', id: d.id, status: d.status }));
    on('permission_request', (d) => dispatch({ t: 'approval_add', a: d }));
    on('permission_resolved', (d) => dispatch({ t: 'approval_remove', id: d.id }));
    on('question', (d) => dispatch({ t: 'question_add', q: d }));
    on('question_answered', (d) => dispatch({ t: 'question_remove', id: d.id }));

    return () => {
      es.close();
      if (docTimer.current) clearInterval(docTimer.current);
    };
  }, []);

  return state;
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
