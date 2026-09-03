import type { CSSProperties } from 'react';

/**
 * In-view attention for pending approvals/questions (debt item 4). Sits at the top of the transcript
 * column so it cannot be scrolled away; `Review` scrolls or switches to the right rail.
 * Renders nothing when nothing is pending.
 */
export interface AttentionBarProps {
  approvals?: number;
  questions?: number;
  /** Bring the approvals/questions into view (scroll the rail to top, or switch the narrow-layout tab). */
  onReview?: () => void;
  style?: CSSProperties;
}

export declare function AttentionBar(props: AttentionBarProps): JSX.Element | null;
