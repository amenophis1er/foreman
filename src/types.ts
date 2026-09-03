/**
 * Shared types for Foreman's orchestrator, persistence, and HTTP layer.
 *
 * Everything the UI sees flows through {@link ForemanEvent}: each event is
 * broadcast to connected SSE clients *and* appended to the run's event log,
 * so replaying a log reproduces exactly what a live client observed.
 */

export type RunStatus = 'running' | 'done' | 'error' | 'interrupted';

/** A linked project — a folder Foreman runs missions in. */
export interface Project {
  id: string;
  /** Display name; defaults to the folder's basename. */
  name: string;
  /** Absolute path of the working directory. */
  folder: string;
  createdAt: number;
  /** Default budget suggested in the composer. */
  defaultBudgetUsd: number;
}

export type WorkerStatus = 'running' | 'done' | 'error';

/** Persisted, replayable event envelope. */
export interface ForemanEvent {
  /** Milliseconds since epoch, assigned at emit time. */
  ts: number;
  /** SSE event name; the UI switches on this. */
  event: string;
  /** JSON-serializable payload; shape depends on `event`. */
  data: unknown;
}

/** Snapshot of one worker, persisted in run metadata. */
export interface WorkerMeta {
  id: string;
  status: WorkerStatus;
  costUsd: number;
  sessionId?: string;
  /** First 500 chars of the task brief, for run-history display. */
  task: string;
}

/** Model choice for an agent; `undefined` inherits the harness default. */
export type ModelChoice = 'opus' | 'sonnet' | 'haiku' | undefined;

/** Persisted run metadata (meta.json). Small, rewritten atomically on change. */
export interface RunMeta {
  id: string;
  /** Owning project; absent on runs recorded before projects existed. */
  projectId?: string;
  /** Model override for the director session. */
  directorModel?: ModelChoice;
  /** Model override for worker sessions (cost lever). */
  workerModel?: ModelChoice;
  /** Number of times this run was resumed after an interruption. */
  resumes?: number;
  /** Tools the human granted "always allow" for this run (survives resume). */
  allowedTools?: string[];
  folder: string;
  mission: string;
  budgetUsd: number;
  status: RunStatus;
  costUsd: number;
  createdAt: number;
  endedAt?: number;
  directorSessionId?: string;
  workers: WorkerMeta[];
}

/** Listing entry returned by GET /runs (meta without heavy fields). */
export type RunSummary = RunMeta;

/** Result of a permission decision made by the human. */
export type PermissionDecision = 'allow' | 'allow_always' | 'deny';
