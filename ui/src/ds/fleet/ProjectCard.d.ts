import type { CSSProperties } from 'react';

/**
 * The fleet's unit of navigation: one linked folder, its status, its live mission and cost — or, when idle,
 * a one-line summary of the last run (debt item 7). 10px radius (the only `--r-md` card), 16px padding.
 */
export interface ProjectCardProps {
  /** Display name; defaults to the folder basename in the product. */
  name: string;
  /** Absolute path, mono, ellipsized from the right. */
  folder: string;
  /**
   * The Claude Code install this project is pinned to, mono, under the folder.
   * Omit when the project inherits the server default — an absent line is the
   * signal that nothing special is going on.
   */
  instance?: string;
  /** The active run, if any. Absent → idle state. `title` is the run's
   *  generated name; without one the brief is shown over two lines instead. */
  run?: { mission: string; title?: string; costUsd: number; budgetUsd: number };
  /** Flat alternative to `run` for markup contexts: passing `mission` puts the card in its running state. */
  mission?: string;
  title?: string;
  costUsd?: number;
  budgetUsd?: number;
  /** Most recent finished run, shown when idle: status · date · cost · one-line mission. */
  /** Latest live event, one line — shown as a ticker under the budget meter. */
  activity?: string;
  lastRun?: { mission: string; title?: string; status: 'done' | 'error' | 'interrupted'; createdAt?: number; costUsd?: number };
  /** Pending approvals — drives the warning border and pulsing strip. */
  pendingPermissions?: number;
  /** Pending director questions. */
  pendingQuestions?: number;
  onOpen?: () => void;
  /** Should open a ConfirmDialog — unlinking is no longer a one-click action. */
  onUnlink?: () => void;
  style?: CSSProperties;
}

export declare function ProjectCard(props: ProjectCardProps): JSX.Element;
