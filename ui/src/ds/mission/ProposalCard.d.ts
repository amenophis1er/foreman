import type { CSSProperties } from 'react';

export interface ProposalStart {
  mission: string;
  budget: number;
}

/**
 * A mission the planner drafted, for the human to read, edit and start. The card is the moment of
 * commitment — where a conversation that has only been reading becomes a crew that will write — so it
 * states the work, the completion criteria and the cap, and never starts anything on its own.
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
