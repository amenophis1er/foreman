// One shared EventSource for the whole app. Subscribers receive every
// enveloped frame ({runId, projectId, data}) plus the SSE event name and can
// filter by run or project themselves.

export type Envelope = { runId: string; projectId: string; data: any };
export type SseListener = (event: string, env: Envelope) => void;

export const SSE_EVENTS = [
  'run_started', 'run_resumed', 'run_finished', 'run_error', 'cost',
  'message', 'steer', 'budget_alert', 'auto_allowed', 'worker_started', 'worker_finished',
  'permission_request', 'permission_resolved', 'question', 'question_answered',
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
