import type { CSSProperties } from 'react';

/**
 * A running mission on the fleet board — one row in the bordered "Running"
 * list. Not `RunRow` (ds/mission), which is a line of a project's history.
 */
export interface FleetRunRowProps {
  name: string;
  /** Absolute path; shown shortened and mono under the name. */
  folder: string;
  /** Generated run name; the brief is shown when absent. */
  title?: string;
  mission: string;
  /** The crew's latest line (`worker-1: writing styles.css`), mono under the title. */
  activity?: string;
  costUsd?: number;
  budgetUsd?: number;
  /** Passed straight to `BudgetMeter`: dollars only when `priced`. */
  costBasis?: 'priced' | 'free' | 'unpriced';
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | null;
  turns?: number;
  /** Full model ids, shown `director · worker` in the right column. */
  directorModel?: string;
  workerModel?: string;
  /** ms epoch of the run's start; the right column shows elapsed time. */
  createdAt?: number;
  onOpen?: () => void;
  style?: CSSProperties;
}

export declare function FleetRunRow(props: FleetRunRowProps): JSX.Element;
