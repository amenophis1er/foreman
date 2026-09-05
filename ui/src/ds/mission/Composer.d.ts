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

export interface ComposerResult {
  mission: string;
  budget: number;
  directorModel: string;
  workerModel: string;
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
  onStart?: (v: ComposerResult) => void;
  style?: CSSProperties;
}

export declare function Composer(props: ComposerProps): JSX.Element;
export declare const MISSION_TEMPLATES: MissionTemplate[];
