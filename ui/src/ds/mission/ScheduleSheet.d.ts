import type { ModelInfo } from '../forms/ModelSelect';
import type { SchedulesPanelCadence, SchedulesPanelSchedule } from './SchedulesPanel';

export interface ScheduleSheetInput {
  name: string;
  brief: string;
  cadence: SchedulesPanelCadence;
  budgetUsd: number;
  directorModel?: string;
  workerModel?: string;
  directorProviderId?: string;
  workerProviderId?: string;
  enabled: boolean;
}

export interface ScheduleSheetProps {
  /** Omit to create; pass a schedule to edit it. */
  schedule?: SchedulesPanelSchedule | null;
  models?: ModelInfo[] | null;
  modelsLoading?: boolean;
  modelsNote?: string;
  modelsInheritNote?: string;
  /** Pre-filled budget on a new schedule; the project's default. */
  defaultBudgetUsd?: number;
  /**
   * `GET /schedules/preview`, debounced by the sheet. Resolve `{error}` to show the server's 400
   * reason under a bad cron expression; while that error stands the primary action is disabled
   * and carries it as its `title`, so resolve `{error}` only for a cadence the server refused.
   * A preview still in flight disables nothing.
   */
  onPreview?: (cadence: SchedulesPanelCadence) => Promise<{ next?: number[]; error?: string }>;
  /** POST or PUT. Resolve the server's error sentence to keep the sheet open showing it; resolve nothing to close. */
  onSave: (input: ScheduleSheetInput) => Promise<string | null | undefined>;
  onClose?: () => void;
}

/** Create/edit sheet for a standing instruction: name, brief, a four-way cadence picker with a live "next three runs" preview, per-run budget, optional director/worker models, and an enabled switch in the footer. */
export declare function ScheduleSheet(props: ScheduleSheetProps): JSX.Element;
