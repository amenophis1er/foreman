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
  /** Pins this project to one Claude Code install; server default when absent. */
  claudeInstance?: ClaudeInstanceRef;
}

/**
 * Which Claude Code install an agent runs under. Decides whose subscription or
 * key is billed and which settings/plugins load.
 */
export interface ClaudeInstanceRef {
  /** CLAUDE_CONFIG_DIR for the agent. */
  configDir?: string;
  /** Claude Code executable; the SDK's bundled one when absent. */
  executable?: string;
  /**
   * Who pays for this project's missions.
   *  - `inherit` (default): whatever the server process authenticates as. An
   *    ANTHROPIC_API_KEY in the server environment outranks any stored login,
   *    so every project bills that key.
   *  - `own-login`: strip inherited API-key credentials from the agent's
   *    environment so the pinned config dir's own stored login pays. This is
   *    what makes per-project accounts work on a single shared server.
   */
  billing?: 'inherit' | 'own-login';
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

/**
 * Model for an agent: a harness alias (opus/sonnet/haiku), a full claude-*
 * model id, or `undefined` to inherit the harness default.
 */
export type ModelChoice = string | undefined;

/** Per-tool decision applied before any prompt is considered. */
export type ToolPolicy = Record<string, 'allow' | 'ask' | 'deny'>;

/** Persisted run metadata (meta.json). Small, rewritten atomically on change. */
export interface RunMeta {
  /** Effective tool policy, snapshotted from Settings at run start. */
  toolPolicy?: ToolPolicy;
  /** Whether read-only tools run silently (Settings; default true). */
  autoAllowReadOnly?: boolean;
  id: string;
  /**
   * Short generated name for the mission, from one cheap model call at start.
   * Absent when the call failed or the run predates titling — the UI falls
   * back to the brief, so nothing depends on this being here.
   */
  title?: string;
  /** Owning project; absent on runs recorded before projects existed. */
  projectId?: string;
  /** Model override for the director session. */
  directorModel?: ModelChoice;
  /** Model override for worker sessions (cost lever). */
  workerModel?: ModelChoice;
  /** Instance this run resolved to at dispatch, so history and resume agree. */
  claudeInstance?: ClaudeInstanceRef;
  /** Number of times this run was resumed after an interruption. */
  resumes?: number;
  /** Tools the human granted "always allow" for this run (survives resume). */
  allowedTools?: string[];
  /** Give agents a headless Playwright browser (navigate, click, screenshot). */
  browserTools?: boolean;
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

/** Free-form UI settings blob (shape owned by the design system's modal). */
export type SettingsValues = Record<string, unknown>;

/** Persisted settings: global values + sparse per-project overlays. */
export interface SettingsFile {
  global: SettingsValues;
  projects: Record<string, SettingsValues>;
}
