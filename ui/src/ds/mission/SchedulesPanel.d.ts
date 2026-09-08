import type { CSSProperties } from 'react';

export type SchedulesPanelCadence =
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; day: number; at: string }
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'cron'; expr: string };

export interface SchedulesPanelSchedule {
  id: string;
  projectId?: string;
  name: string;
  brief: string;
  cadence: SchedulesPanelCadence;
  /** Budget for one run, not for the schedule's life. */
  budgetUsd: number;
  directorModel?: string;
  workerModel?: string;
  directorProviderId?: string;
  workerProviderId?: string;
  enabled: boolean;
  createdAt: number;
  lastRunId?: string;
  lastRunAt?: number;
  lastOutcome?: 'done' | 'error' | 'interrupted' | 'skipped';
  lastNote?: string;
  /** Next firing, ms epoch; null when disabled or nothing is scheduled. */
  nextRunAt: number | null;
  consecutiveFailures: number;
  /** Why it stopped firing by itself. Rendered as a sentence, never as colour alone. */
  pausedReason: null | 'failures' | 'monthly-cap' | 'human';
}

/** Each action resolves to the server's error sentence, or null/undefined when it worked. */
export type ScheduleAction = (s: SchedulesPanelSchedule) => Promise<string | null | undefined>;

export interface SchedulesPanelProps {
  schedules: SchedulesPanelSchedule[];
  /** What scheduled runs have cost this month, and the ceiling that pauses them. A cap of 0 hides the line. */
  monthSpendUsd?: number;
  monthlyCapUsd?: number;
  loading?: boolean;
  error?: string | null;
  /** Used for the last-run link (`#/p/<projectId>/r/<runId>`) when the schedule does not carry its own. */
  projectId: string;
  onNew?: () => void;
  onEdit?: (s: SchedulesPanelSchedule) => void;
  onPause: ScheduleAction;
  onResume: ScheduleAction;
  /** A 409 ("a mission is already running here") comes back as its sentence and is shown on the row. */
  onRunNow: ScheduleAction;
  onDelete: ScheduleAction;
  style?: CSSProperties;
}

/** The planning rail's Schedules block: one row per standing instruction — cadence in words, next run as a relative time, last outcome linking to its run, and pause/resume, Run now, edit, delete. */
export declare function SchedulesPanel(props: SchedulesPanelProps): JSX.Element;

/** A cadence in words — `every Monday 09:00`, `daily 07:30`, `every 6 hours`. Mirrors `describeCadence` in src/schedule.ts. */
export declare function cadenceWords(cadence: SchedulesPanelCadence | null | undefined): string;

/** `in 3 h` · `in 20 min` · `in 2 days` · `due now`. Null when there is no next time. */
export declare function whenWords(at: number | null | undefined, now?: number): string | null;
