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
      /**
       * Name of a server environment variable holding the key. The fallback
       * when nothing is stored for this provider; omit it entirely to use a
       * stored key alone.
       */
      apiKeyEnv?: string;
      /**
       * This endpoint requires a credential. Distinguishes "a key is stored
       * for it" from "it needs none at all" — a local Ollama is the latter,
       * and inferring from the absence of `apiKeyEnv` would make every stored
       * key look like no key.
       */
      needsKey?: boolean;
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

/**
 * What a run's spend *is* — which is a different question from how much.
 *
 * A boolean `metered` used to carry this, and it collapsed two states that
 * are not the same thing at all: a local model that costs nothing and an
 * OpenAI key that costs real money Foreman holds no price table for both
 * answered `false`, and rendered identically. "You are spending nothing" and
 * "you are spending an amount I cannot tell you" are different sentences to
 * put in front of someone, and only one of them is a reason to go and look at
 * a vendor's dashboard.
 *
 *  - `priced`   — the dollar figure is the real one. Dollars are displayed,
 *                 and the budget cap binds.
 *  - `free`     — nothing is charged per token; the model runs on hardware
 *                 the operator already owns. Tokens and turns are the only
 *                 true units.
 *  - `unpriced` — real spend, of an amount Foreman cannot state: a paid
 *                 endpoint with no price source, or a subscription allowance
 *                 being consumed. Shown in tokens and turns like `free`, but
 *                 said out loud to be untracked rather than passed off as
 *                 costing nothing.
 *
 * Only `priced` may display or enforce dollars. `free` and `unpriced` differ
 * in what they say and never in what they enforce — which is why this is
 * three states and not four: the fourth distinction people reach for
 * (subscription vs. pay-as-you-go) changes no behaviour here, and the
 * provider label already carries it in words.
 */
export type CostBasis = 'priced' | 'free' | 'unpriced';

/**
 * A run's cost basis, including for runs that predate the field.
 *
 * The old `metered: false` meant "not priceable", which is the union of
 * `free` and `unpriced` — so it cannot be split after the fact. This reads it
 * as `unpriced`, because of the two possible errors, describing real spend as
 * free is the one that costs somebody money.
 */
export function costBasisOf(meta: { costBasis?: CostBasis; metered?: boolean }): CostBasis {
  if (meta.costBasis) return meta.costBasis;
  return meta.metered === false ? 'unpriced' : 'priced';
}

/**
 * One cost basis for a run whose two roles may not share one.
 *
 * `priced` wins outright: if any part of the run bills real dollars, the
 * dollar cap must still arm, because the alternative is an uncapped run
 * spending genuine money. It is not a *precise* figure on a mixed run — the
 * SDK prices the gateway role's tokens with Anthropic's table too, so the
 * total overstates — but overstating a real bill is a safe error in a way
 * that ignoring one is not. A per-role price table is what fixes it properly.
 *
 * Otherwise `unpriced` beats `free`, on the same principle that decides a
 * single provider: never call a run free when part of it is not.
 */
export function combineBasis(a: CostBasis, b: CostBasis): CostBasis {
  if (a === 'priced' || b === 'priced') return 'priced';
  if (a === 'unpriced' || b === 'unpriced') return 'unpriced';
  return 'free';
}

/** Whether dollars may be displayed or enforced at all. The one real branch. */
export function isPriced(meta: { costBasis?: CostBasis; metered?: boolean }): boolean {
  return costBasisOf(meta) === 'priced';
}

/**
 * Real token usage. `costUsd` is notional on a subscription plan and
 * fictional through a gateway (the SDK prices foreign tokens with
 * Anthropic's rate table) — token counts are what actually moved on any
 * provider, so this is what an unmetered run's meter should show instead of
 * a dollar figure nobody billed.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Snapshot of one worker, persisted in run metadata. */
export interface WorkerMeta {
  id: string;
  status: WorkerStatus;
  costUsd: number;
  sessionId?: string;
  /** First 500 chars of the task brief, for run-history display. */
  task: string;
  /**
   * The worker's final report, kept on the record rather than handed back
   * once and forgotten: spawning is asynchronous, so the director reads
   * results through check_workers / wait_for_worker — possibly more than
   * once, possibly after a restart — and a report that lived only in a
   * returned promise would be gone by then.
   */
  report?: string;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** Last SDK message seen; what "seconds since last activity" is measured from. */
  lastActivityAt?: number;
  toolCalls?: number;
  /**
   * Rolling window of the last few activity lines (tool name + a short arg
   * hint, or the head of an assistant message). The director cannot see a
   * worker's transcript; this is the glance that tells "reading tests" apart
   * from "re-running the same failing command".
   */
  recent?: string[];
  /**
   * The worker's own account of where it is, from its report_progress tool.
   * Kept apart from `recent` because the two answer different questions:
   * `recent` is what the harness saw the worker call, this is what the
   * worker says it is doing and how far along it is — the only signal that
   * tells "two of three files written, stuck on the third" from flailing.
   * Latest report wins; `at` dates it so a stale one reads as stale.
   */
  progress?: WorkerProgress;
}

/** One report_progress call, as stored on the record and sent to the UI. */
export interface WorkerProgress {
  /** One-line summary, capped at 200 chars by the tool. */
  status: string;
  done?: string[];
  next?: string;
  blocked?: string;
  at: number;
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
   * Provider serving each role, when it differs from the run's own.
   *
   * A model carries the provider that serves it, so a run can put a capable
   * director on one and cheap workers on another — the configuration the
   * whole provider model exists to make possible. Absent means "the run's
   * provider", which is every run recorded before this existed.
   */
  directorProviderId?: string;
  workerProviderId?: string;
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
  /**
   * The branch this mission runs on, when the folder is a repository and the
   * project runs missions on branches of their own. Foreman made it from
   * `base` at start and commits on it at the end; it never merges or pushes.
   */
  git?: { branch: string; base: string; baseHead: string | null; commits?: number; commit?: string; /** The pull request the human opened from this run, once they did. */ pr?: string; /** Its fate, once known to be final (merged or closed); open is re-asked. */ prState?: 'merged' | 'closed' };
  /** Tools the human granted "always allow" for this run (survives resume). */
  allowedTools?: string[];
  /**
   * Absolute directories the human opened for this run by approving "always"
   * on a folder-boundary card (see `PendingPermission.escapedPath`). Paths
   * under them count as inside the mission folder. Persisted beside
   * `allowedTools` for the same reason: a resume must not re-ask what the
   * human already answered.
   */
  allowedRoots?: string[];
  /** Dev servers the crew exposed through Foreman's proxy (see services.ts). */
  services?: Array<{ port: number; label: string; path: string; since: number }>;
  /**
   * How long an approval card or director question may wait for the human
   * before it is resolved with its unattended default (deny / "decide
   * yourself"). Absent means the orchestrator's default; 0 disables the timer
   * for a run someone intends to babysit.
   */
  askTimeoutMs?: number;
  /** Give agents a headless Playwright browser (navigate, click, screenshot). */
  browserTools?: boolean;
  /**
   * Which cap ended the last attempt, when one did. The dashboard reads it
   * to offer the one action that helps — raise the budget and resume — and
   * a resume clears it. Absent when the run ended for any other reason.
   */
  /**
   * Percent of the cap at which the director is told to start winding down,
   * frozen at dispatch like the cap itself. Absent means the default.
   */
  budgetWarnAt?: number;
  stopReason?: 'budget' | 'turns' | 'time' | 'tokens';
  /** When the run's record was frozen (MISSION.md and deck copied beside it); absent on older runs. */
  snapshotAt?: number;
  /**
   * The server process driving this run. The startup sweep that marks
   * abandoned runs interrupted leaves a run alone while its owner is alive —
   * a second Foreman on the same data directory (a dev server beside the
   * installed one) once swept a live mission's record out from under it.
   */
  ownerPid?: number;
  folder: string;
  mission: string;
  budgetUsd: number;
  /**
   * What this run's spend *is* — see {@link CostBasis}. Absent on runs
   * recorded before the split; read it through {@link costBasisOf}, never
   * directly, so those runs keep answering.
   */
  costBasis?: CostBasis;
  /**
   * @deprecated Superseded by {@link costBasis}, which distinguishes the two
   * states this boolean collapsed. Still read for runs recorded before the
   * split, and still written beside `costBasis` so a downgrade is survivable.
   * Nothing new should branch on it.
   */
  metered?: boolean;
  /** Director turns before the run winds down. Universal; provider-independent. */
  maxTurns?: number;
  /** Wall-clock cap. Matters most exactly where dollars matter least. */
  maxSeconds?: number;
  /**
   * Total tokens — input, output and cache alike — before the run winds down.
   *
   * The third bound, and the one that was missing: a run that costs nothing
   * per token, or that Foreman cannot price, has only turns and the clock to
   * stop it. Neither notices a chatty director whose turns are cheap and
   * enormous, re-reading a large context a hundred and fifty times inside the
   * time cap. Tokens are the resource actually being consumed there, so they
   * are what the cap should count.
   */
  maxTokens?: number;
  /**
   * How long a worker may produce nothing before it is treated as stalled and
   * stopped. Absent means the orchestrator's default. Raise it for slow local
   * models whose first token legitimately takes minutes.
   */
  workerSilenceMs?: number;
  status: RunStatus;
  costUsd: number;
  /**
   * Where `costUsd` came from, kept apart so a resume adds to the right
   * pile: `native` is the SDK's own figure for Anthropic-native roles,
   * `rated` is gateway tokens priced from published or listed rates, and
   * `ledger` is what a gateway upstream itself reported per response. When
   * the upstream reports, its number outranks the rated one for the same
   * tokens — the party that sends the bill wins.
   */
  costParts?: { native: number; rated: number; ledger: number };
  /**
   * Token counts accumulated from every director and worker `result`
   * message's `usage` object. Absent on runs recorded before this landed.
   */
  usage?: TokenUsage;
  /**
   * Director turns taken so far, persisted so a resumed run keeps counting
   * against {@link maxTurns} instead of restarting the cap from zero — the
   * orchestrator's private counter is only ever accurate within one process.
   */
  turns?: number;
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
  /**
   * The planner judged the DONE WHEN criteria need a browser (a page must
   * load, render, be console-clean or be screenshotted). The card starts with
   * the switch on. Absent means "the planner did not say", not "no".
   */
  browser?: boolean;
  /**
   * The planner's model recommendations, already validated against the
   * machine's list — an id it could not have picked from the list is dropped
   * and the role inherits. The card pre-selects these; the human can change
   * them. `modelRationale` is the planner's one line on why, shown beside
   * the pickers so the choice reads as a suggestion with a reason, not a
   * setting that appeared.
   */
  directorModel?: string;
  workerModel?: string;
  directorProviderId?: string;
  workerProviderId?: string;
  modelRationale?: string;
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
