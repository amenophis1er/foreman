// One shared EventSource for the whole app. Subscribers receive every
// enveloped frame ({runId, projectId, data}) plus the SSE event name and can
// filter by run or project themselves.

export type Envelope = {
  /** Null on planning-chat frames — a conversation belongs to no run. */
  runId: string;
  projectId: string;
  /** True for a project's planning conversation, absent for mission frames. */
  chat?: boolean;
  data: any;
};
export type SseListener = (event: string, env: Envelope) => void;

/**
 * Every event name the server emits. An EventSource delivers ONLY the named
 * events it has a listener for — a name missing here is not an error, it is
 * silence: the frame arrives and is dropped, and the UI shows it only after a
 * reload replays the log. Thirteen events shipped that way in one day before
 * anyone noticed, because each one looked fine on replay.
 *
 * `src/sse-events.test.ts` scans the server for `emit('…')` names and fails
 * if any is absent from this list. Add the name here in the same change that
 * emits it.
 */
export const SSE_EVENTS = [
  // run lifecycle + economics
  'run_started', 'run_resumed', 'run_finished', 'run_error', 'run_titled', 'cost',
  'budget_alert', 'budget_stop', 'usage_limit', 'mission_incomplete', 'settings_changed',
  // transcript + crew
  'message', 'steer', 'worker_started', 'worker_progress', 'worker_finished',
  'worker_stalled', 'worker_looping', 'director_looping', 'service_exposed',
  // governance: permissions and questions
  'auto_allowed', 'auto_denied', 'root_allowed',
  'permission_request', 'permission_resolved', 'permission_timeout',
  'question', 'question_answered', 'question_timeout',
  // planning conversation
  'chat_message', 'chat_turn', 'chat_cost', 'chat_error', 'chat_cleared', 'chat_proposal_dismissed',
  'chat_question', 'chat_answered', 'chat_question_timeout',
  'mission_proposed', 'mission_started',
  // server
  'models_changed',
  // git: the mission's branch
  'git_branch', 'git_note', 'git_committed',
] as const;

const listeners = new Set<SseListener>();
const connectionListeners = new Set<(up: boolean) => void>();
let source: EventSource | null = null;

function ensureSource(): void {
  if (source) return;
  source = new EventSource('/events');
  source.onopen = () => connectionListeners.forEach((fn) => fn(true));
  source.onerror = () => connectionListeners.forEach((fn) => fn(false));
  for (const name of SSE_EVENTS) {
    source.addEventListener(name, (raw) => {
      const env = JSON.parse((raw as MessageEvent).data) as Envelope;
      listeners.forEach((fn) => fn(name, env));
    });
  }
}

/** Subscribes to all enveloped events; returns an unsubscribe function. */
export function onSse(fn: SseListener): () => void {
  ensureSource();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribes to connection up/down; returns an unsubscribe function. */
export function onConnection(fn: (up: boolean) => void): () => void {
  ensureSource();
  connectionListeners.add(fn);
  return () => connectionListeners.delete(fn);
}
