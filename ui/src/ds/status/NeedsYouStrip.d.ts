import type { CSSProperties } from 'react';

/**
 * "Needs you — 2 approvals, 1 question" with a bell icon, in warning color, pulsing at 1.6s.
 * Renders nothing when both counts are zero. The card it sits in also takes a `--status-warning` border.
 */
export interface NeedsYouStripProps {
  /** Pending tool approvals. */
  approvals?: number;
  /** Pending director questions. */
  questions?: number;
  /** One of `questions` is the planner's; the strip names it, since it is answered in the chat, not a run. */
  planner?: boolean;
  style?: CSSProperties;
}

export declare function NeedsYouStrip(props: NeedsYouStripProps): JSX.Element | null;
