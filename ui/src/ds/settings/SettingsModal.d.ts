import type { CSSProperties } from 'react';
import type { NotifyPanelProps } from './NotifyPanel';
import type { ModelInfo } from '../forms/ModelSelect';
import type { ProviderRef, DiscoveredInstance, OllamaInfo } from './ProviderPicker';

export type SettingsScope = 'global' | 'project';
export type SettingsSectionId = 'provider' | 'models' | 'budget' | 'approvals' | 'appearance' | 'notifications' | 'projects';

export interface Settings {
  directorModel?: string; workerModel?: string;
  /** The planning conversation's model. Sonnet by default. */
  plannerModel?: string;
  /** Provider serving each role, from the picked model's row. */
  directorProviderId?: string; workerProviderId?: string;
  budgetCap?: number; budgetWarnAt?: number; budgetHardStop?: boolean;
  autoAllowReadOnly?: boolean; alwaysSurvivesResume?: boolean;
  toolPolicy?: Record<string, 'allow' | 'ask' | 'deny'>;
  theme?: 'system' | 'dark' | 'light';
  /** Multiplies the whole type scale; `default` follows the browser's own font size. */
  textSize?: 'small' | 'default' | 'large' | 'larger';
  density?: 'comfortable' | 'compact'; showTimestamps?: boolean;
  notifyNeedsYou?: boolean; notifyDone?: boolean; notifyBudget?: boolean; sound?: boolean;
  projectsRoot?: string; missionDir?: string; showHidden?: boolean;
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
