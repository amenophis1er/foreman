import type { CSSProperties } from 'react';
import type { NotifyPanelProps } from './NotifyPanel';
import type { ModelInfo } from '../forms/ModelSelect';
import type { ProviderRef, DiscoveredInstance, OllamaInfo } from './ProviderPicker';

export type SettingsScope = 'global' | 'project';
export type SettingsSectionId = 'provider' | 'models' | 'crew' | 'budget' | 'approvals' | 'appearance' | 'notifications' | 'projects';

/**
 * A named role a mission can be given at compose time. `reviewer` returns a
 * verdict on the run's final diff; with `requiredForDone` that verdict must be
 * PASS before the run is recorded done. `id` is machine-facing and generated
 * from the name — never edited.
 */
export interface CrewPreset {
  id: string;
  name: string;
  kind: 'reviewer' | 'specialist';
  model?: string;
  /** Provider serving the model, from the picked model's row. */
  providerId?: string;
  brief: string;
  toolPolicy?: 'read-only' | 'default';
  /** Reviewers only; ignored for a specialist. */
  requiredForDone: boolean;
}

export interface Settings {
  directorModel?: string; workerModel?: string;
  /** The planning conversation's model. Sonnet by default. */
  plannerModel?: string;
  fleetPlannerModel?: string;
  /** Provider serving each role, from the picked model's row. */
  directorProviderId?: string; workerProviderId?: string;
  budgetCap?: number; budgetWarnAt?: number; budgetHardStop?: boolean;
  scheduledMonthlyCapUsd?: number;
  /**
   * The standing crew, in the order the composer offers it. Absent means the
   * two built-ins; a project's list replaces the global one whole rather than
   * merging into it, like every other key here.
   */
  crewPresets?: CrewPreset[];
  autoAllowReadOnly?: boolean; alwaysSurvivesResume?: boolean;
  toolPolicy?: Record<string, 'allow' | 'ask' | 'deny'>;
  theme?: 'system' | 'dark' | 'light';
  /** Multiplies the whole type scale; `default` follows the browser's own font size. */
  textSize?: 'small' | 'default' | 'large' | 'larger';
  density?: 'comfortable' | 'compact'; showTimestamps?: boolean;
  notifyNeedsYou?: boolean; notifyDone?: boolean; notifyBudget?: boolean; sound?: boolean;
  projectsRoot?: string; missionDir?: string; showHidden?: boolean;
  /** In a repository, each mission runs on a branch of its own (default true). */
  gitBranchPerMission?: boolean;
  /**
   * Where a mission works. `shared` (default) is the project folder itself;
   * `worktree` gives each mission a git worktree of its own under Foreman's
   * home, which is what lets several run at once. Repositories only.
   */
  isolation?: 'shared' | 'worktree';
  /**
   * How many missions may run here at once: 1 for a shared checkout (pinned by
   * the server), up to 5 with worktrees. Defaults to 2 — the server's own
   * worktree default — so saving an untouched form changes nothing.
   */
  maxConcurrentMissions?: number;
}

/**
 * The settings surface: a modal with a section sidebar, a Global / <project> scope switch in the header, and a Save / Cancel bar.
 * Project scope is an overlay: rows inherit global until changed, then show `override · reset to global`.
 */
export interface SettingsModalProps {
  /** Saved global values; merged over `DEFAULT_SETTINGS`. */
  global?: Settings;
  /** Saved per-project overrides — only keys the project has changed. */
  project?: Settings;
  /** Enables the project scope tab. Omit when opened from the fleet page. */
  projectName?: string;
  /**
   * Whether the open project's folder is a git repository (`p.git.repo`).
   * `false` locks the worktree isolation choice, with the reason on screen —
   * the server refuses it too, this is the friendly half. Omitted means
   * unknown (global scope), and nothing is locked.
   */
  projectIsRepo?: boolean;
  /**
   * The top level of the repository the open project's folder is in
   * (`p.git.root`). When it differs from `projectFolder` the folder is inside a
   * repository without being its root, and worktree isolation is locked with
   * that reason — the server refuses it as well. Either path missing means
   * unknown, and nothing is locked.
   */
  projectGitRoot?: string;
  /** The open project's folder, compared against `projectGitRoot`. */
  projectFolder?: string;
  /**
   * Why the last Save was refused, in the server's words. Shown in the footer
   * where the save state otherwise is; the modal stays open with the edits
   * intact so they can be corrected rather than silently lost.
   */
  saveError?: string;
  /** Model list for the two pickers. Scoped to the open project's provider —
   *  without it they fall back to the built-in Anthropic list, which is wrong
   *  for a project pinned to anything else. */
  models?: ModelInfo[] | null;
  modelsLoading?: boolean;
  modelsNote?: string;
  /** The open project's current provider pin. `null`/absent means the server
   *  default. Projects section, project scope only — see `ProviderPicker`. */
  provider?: ProviderRef | null;
  /** Discovered Claude Code installs, passed through to `ProviderPicker`. */
  providerInstances?: DiscoveredInstance[];
  /** A running local Ollama daemon, passed through to `ProviderPicker`. */
  providerOllama?: OllamaInfo | null;
  /** A Codex install, for the global-scope "what this machine offers" panel. */
  providerCodex?: { home: string; signedIn: boolean } | null;
  /** Whether a key is on file for the project's provider. Never the key. */
  providerHasKey?: boolean;
  providerKeyBusy?: boolean;
  providerKeyError?: string;
  /** Stores/clears the key immediately — its own endpoint, not part of Save. */
  onStoreProviderKey?: (providerId: string, key: string) => void;
  onClearProviderKey?: (providerId: string) => void;
  scope?: SettingsScope;
  /** Pass with `scope` to control it; without it `scope` is the initial value. */
  onScope?: (s: SettingsScope) => void;
  section?: SettingsSectionId;
  /** Pass with `section` to control it; without it `section` is the initial value. */
  onSection?: (s: SettingsSectionId) => void;
  /**
   * Fires on Save with the full global object, the sparse project overlay,
   * and `provider` — `undefined` when the pin wasn't touched this session,
   * `null` to clear it back to the server default, or a `ProviderRef` to set
   * it. Provider changes ride through `PATCH /projects/:id`, a different
   * endpoint than the rest of Settings, so the caller must route it there.
   */
  onSave?: (v: { global: Settings; project: Settings; provider?: ProviderRef | null }) => void;
  onClose?: () => void;
  /** Projects section, project scope only. */
  onUnlink?: () => void;
  /** Settings → Notifications (global): channel status and actions from useNotify(). */
  notify?: NotifyPanelProps;
  style?: CSSProperties;
}

export declare function SettingsModal(props: SettingsModalProps): JSX.Element;
export declare const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; icon: string }[];
export declare const DEFAULT_SETTINGS: Required<Settings>;
/** The two crew presets shown until someone edits them. Mirrors `BUILT_IN_PRESETS` in `src/crew.ts`. */
export declare const BUILT_IN_PRESETS: CrewPreset[];
