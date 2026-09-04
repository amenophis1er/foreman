import type { CSSProperties } from 'react';

export type SettingsScope = 'global' | 'project';
export type SettingsSectionId = 'models' | 'budget' | 'approvals' | 'appearance' | 'notifications' | 'projects';

export interface Settings {
  directorModel?: string; workerModel?: string;
  budgetCap?: number; budgetWarnAt?: number; budgetHardStop?: boolean;
  autoAllowReadOnly?: boolean; alwaysSurvivesResume?: boolean;
  toolPolicy?: Record<string, 'allow' | 'ask' | 'deny'>;
  theme?: 'system' | 'dark' | 'light'; density?: 'comfortable' | 'compact'; showTimestamps?: boolean;
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
  scope?: SettingsScope;
  /** Pass with `scope` to control it; without it `scope` is the initial value. */
  onScope?: (s: SettingsScope) => void;
  section?: SettingsSectionId;
  /** Pass with `section` to control it; without it `section` is the initial value. */
  onSection?: (s: SettingsSectionId) => void;
  /** Fires on Save with the full global object and the sparse project overlay. */
  onSave?: (v: { global: Settings; project: Settings }) => void;
  onClose?: () => void;
  /** Projects section, project scope only. */
  onUnlink?: () => void;
  style?: CSSProperties;
}

export declare function SettingsModal(props: SettingsModalProps): JSX.Element;
export declare const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; icon: string }[];
export declare const DEFAULT_SETTINGS: Required<Settings>;
