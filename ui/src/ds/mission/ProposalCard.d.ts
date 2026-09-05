import type { CSSProperties } from 'react';

import type { ModelInfo } from '../forms/ModelSelect';

/** The full start shape — identical to what the Composer submits. */
export interface ProposalStart {
  mission: string;
  budget: number;
  /** '' inherits the project's Settings default. */
  directorModel?: string;
  workerModel?: string;
  directorProviderId?: string;
  workerProviderId?: string;
  browserTools?: boolean;
}

/**
 * A mission the planner drafted, for the human to read, edit and start. The card is the moment of
 * commitment — where a conversation that has only been reading becomes a crew that will write — so it
 * states the work, the completion criteria and the cap, and never starts anything on its own.
 *
 * It carries every lever the Composer has (budget, director, workers, browser): a mission committed
 * without the browser it needs, or on a model nobody chose, is the mistake that costs an hour to notice.
 */
export interface ProposalCardProps {
  /** The brief, editable in place. */
  mission: string;
  /** Verifiable completion criteria, shown as unticked boxes. */
  doneWhen?: string[];
  /** Suggested cap, editable in place. */
  budgetUsd?: number;
  /** One short paragraph on why this shape and this budget. */
  rationale?: string;
  /** The planner judged the criteria need a browser; the switch starts on. The human can still flip it. */
  browser?: boolean;
  /**
   * The planner's model recommendations, already validated server-side against the machine's list.
   * Pre-select the pickers; '' or absent inherits. The human can change either.
   */
  directorModel?: string;
  workerModel?: string;
  directorProviderId?: string;
  workerProviderId?: string;
  /** The planner's one line on why those two, shown above the pickers. */
  modelRationale?: string;
  /** Same server-provided list the Composer's pickers use. */
  models?: ModelInfo[] | null;
  modelsLoading?: boolean;
  modelsNote?: string;
  modelsInheritNote?: string;
  /** The start request is in flight. */
  busy?: boolean;
  /** Server error from the start attempt (typically a 409). */
  error?: string;
  onStart?: (v: ProposalStart) => void;
  /** Dismiss without spending a turn saying "no". The next proposal replaces it. */
  onDismiss?: () => void;
  style?: CSSProperties;
}

export declare function ProposalCard(props: ProposalCardProps): JSX.Element;
