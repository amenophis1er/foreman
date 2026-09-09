import type { CSSProperties } from 'react';
import type { ModelInfo } from '../forms/ModelSelect';

export interface MissionTemplate {
  id: string;
  label: string;
  /** Lucide name for the chip. */
  icon?: string;
  /** Brief skeleton with `<angle-bracket>` slots for the operator to fill. */
  brief: string;
  budget: number;
  /** Model ids from `GET /models`; `''` inherits. */
  director: string;
  worker: string;
}

/**
 * A named role a mission can opt into, as Settings stores it. A reviewer is a
 * worker with a fixed brief, its own model and (usually) a read-only tool
 * policy; when `requiredForDone`, its PASS verdict on the final diff is a
 * condition of the run being recorded done.
 *
 * Structurally the `CrewPreset` Settings edits (`ds/settings/SettingsModal`),
 * declared here so the composer does not depend on the settings surface.
 */
export interface CrewPreset {
  id: string;
  name: string;
  kind: 'reviewer' | 'specialist';
  /** Model id; absent inherits the project's worker model. */
  model?: string;
  providerId?: string;
  brief?: string;
  toolPolicy?: 'read-only' | 'default';
  requiredForDone?: boolean;
}

/** The crew row shared by the Composer and the ProposalCard. Renders nothing when `presets` is empty. */
export interface CrewTogglesProps {
  presets?: CrewPreset[];
  /** Selected preset ids. */
  value?: string[];
  /** The new selection, in `presets` order. */
  onChange?: (ids: string[]) => void;
  style?: CSSProperties;
}

/** One action offered beside the error, e.g. "Start anyway" after a refusal the human can override. */
export interface ComposerErrorAction {
  label: string;
  onClick: () => void;
}

export interface ComposerResult {
  mission: string;
  budget: number;
  directorModel: string;
  workerModel: string;
  /** Provider serving each role, from the picked model's own row. Absent means
   *  the project's provider — which is every Anthropic pick. */
  directorProviderId?: string;
  workerProviderId?: string;
  browserTools?: boolean;
  /** Ids of the crew presets toggled on, in `crewPresets` order. Empty means no crew. */
  crew: string[];
  /** Files attached via the paperclip, drag-drop onto the editor, or pasting an image. Not persisted with the draft. */
  attachments: File[];
}

/**
 * The whole of mission setup: template chips, an editor frame (Write / Preview tabs, quote · code · code-block insertion,
 * attachments row), a parameter tray (budget cap, director, workers) and Start. ⌘/Ctrl+Enter starts.
 * Drafts autosave to localStorage per folder and are restored on return.
 */
export interface ComposerProps {
  /** Absolute folder path, shown in mono under the heading; also the draft key. */
  folder: string;
  defaultBudgetUsd?: number;
  /** Server error, shown inline (typically a 409: a mission is already running). */
  error?: string;
  /** Offered next to the error, when the refusal is one the human can override. */
  errorAction?: ComposerErrorAction;
  busy?: boolean;
  /** Override the built-in Bug fix / Add tests / Refactor / Audit set. */
  templates?: MissionTemplate[];
  /** From `ModelSelect.useModels('/models')`; both pickers share it. Omit for the built-in fallback list. */
  models?: ModelInfo[] | null;
  modelsLoading?: boolean;
  /** Passed to both pickers — why the list is short or empty. */
  modelsNote?: string;
  /** What the pickers' Default row inherits from on this provider. */
  modelsInheritNote?: string;
  /** Crew roles offered as toggles, from Settings. Empty hides the row entirely. */
  crewPresets?: CrewPreset[];
  /** Initial selection — the caller remembers it per project. */
  crew?: string[];
  /** Every change to the selection, so the caller can remember it. */
  onCrewChange?: (ids: string[]) => void;
  onStart?: (v: ComposerResult) => void;
  style?: CSSProperties;
}

export declare function Composer(props: ComposerProps): JSX.Element;
export declare function CrewToggles(props: CrewTogglesProps): JSX.Element | null;
export declare const MISSION_TEMPLATES: MissionTemplate[];
