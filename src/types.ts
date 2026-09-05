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
  /**
   * Who serves and who pays. Absent means the legacy `claudeInstance` below
   * (or the server default) — see providerOf() in provider.ts.
   */
  provider?: ProviderRef;
  /** @deprecated Pre-provider pin. Read through providerOf(); never written. */
  claudeInstance?: ClaudeInstanceRef;
}

/**
 * @deprecated The pre-provider shape, still read from records written before
 * {@link ProviderRef} existed. Never written. See providerFromLegacy().
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

/**
 * Who serves the model, who pays for it, and where requests go — one choice,
 * not three settings. See src/provider.ts and docs/provider-model.md; the
 * union shape is what makes "subscription login + custom base URL", the
 * combination that leaks a token, unrepresentable.
 */
export type ProviderRef =
  /** An installed Claude Code, using whatever it is logged into. Ambient. */
  | {
      kind: 'claude-code';
      /** CLAUDE_CONFIG_DIR; the server default when absent. */
      configDir?: string;
      /** Claude Code executable; the SDK's bundled one when absent. */
      executable?: string;
      /** Strip inherited key credentials so this install's own login pays. */
      ownLogin?: boolean;
    }
  /** An Anthropic API key Foreman is told about by name, never by value. */
  | {
      kind: 'anthropic-api';
      /** Stable id; names this provider's Foreman-owned config dir. */
      id: string;
      /** Server environment variable holding the key. Foreman stores no secrets. */
      apiKeyEnv: string;
      model?: string;
    }
  /** An installed Codex CLI, using the login `codex login` already stored. */
  | {
      kind: 'codex';
      id: string;
      /** CODEX_HOME; `~/.codex` when absent. */
      codexHome?: string;
      /** Codex inference backend; the public one when absent. */
      upstreamUrl?: string;
      model?: string;
    }
  /** Anything speaking OpenAI Chat Completions: Ollama, OpenRouter, vLLM, … */
  | {
      kind: 'openai-compatible';
      id: string;
      baseUrl: string;
      /** Omit for an endpoint that needs no credential, e.g. a local Ollama. */
      apiKeyEnv?: string;
      /** Short name for badges — "Ollama", "OpenRouter". */
      label?: string;
      model?: string;
    };

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
  /**
   * Provider frozen at dispatch, so history and resume agree — and so a later
   * settings change cannot move an in-flight or resumed run to another
   * provider, or another bill.
   */
  provider?: ProviderRef;
  /** @deprecated Pre-provider pin, still read for runs recorded before providers. */
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

/**
 * A project's planning conversation — the talk that happens before a mission.
 *
 * Only the session id and the running tally are kept here; the conversation
 * itself is the append-only event log beside this file, exactly like a run's.
 * There is no process behind it: each turn resumes the stored session and
 * exits, so an idle conversation costs nothing but disk.
 */
export interface ChatMeta {
  projectId: string;
  /** Claude Code session to resume; absent until the first turn completes. */
  sessionId?: string;
  /** Everything this conversation has cost, for the whole of its life. */
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  /** The most recent mission the planner proposed, if it has not been used. */
  proposal?: MissionProposal;
}

/** A mission the planner drafted, waiting for the human to start or discard. */
export interface MissionProposal {
  id: string;
  /** The brief, ready to go into the composer. */
  mission: string;
  /** Verifiable completion criteria, shown as a checklist. */
  doneWhen: string[];
  /** What the planner thinks it should cost. The human always sees it. */
  budgetUsd: number;
  /** Why this budget and this shape — one short paragraph. */
  rationale?: string;
  createdAt: number;
}

/** Result of a permission decision made by the human. */
export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

/** Free-form UI settings blob (shape owned by the design system's modal). */
export type SettingsValues = Record<string, unknown>;

/** Persisted settings: global values + sparse per-project overlays. */
export interface SettingsFile {
  global: SettingsValues;
  projects: Record<string, SettingsValues>;
}
