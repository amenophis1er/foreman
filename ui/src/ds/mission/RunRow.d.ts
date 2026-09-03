import type { CSSProperties } from 'react';

/** One past or current run in the history rail. Selecting one replays it through the same view as live. */
export interface RunRowProps {
  /** Mission brief; clipped to one line with an ellipsis, full text in the tooltip. */
  mission: string;
  /** Epoch ms. Rendered `Sep 3, 12:16 AM`. */
  createdAt?: number;
  costUsd?: number;
  status?: 'idle' | 'running' | 'done' | 'error' | 'interrupted';
  selected?: boolean;
  /** The run whose crew is shown — semibold title. */
  current?: boolean;
  onSelect?: () => void;
  style?: CSSProperties;
}

export declare function RunRow(props: RunRowProps): JSX.Element;
