import type { CSSProperties } from 'react';

/** One past or current run in the history rail. Selecting one replays it through the same view as live. */
export interface RunRowProps {
  /** Mission brief; clipped to one line with an ellipsis, full text in the tooltip. */
  mission: string;
  /** Generated short name for the run. Shown instead of the brief when present;
   *  the brief stays in the tooltip either way. */
  title?: string;
  /** Epoch ms. Rendered `Sep 3, 12:16 AM`. */
  createdAt?: number;
  costUsd?: number;
  /** What `costUsd` is. `priced` renders dollars; `unpriced` renders tokens from `usage`; `free` renders no spend. Default `priced`. */
  costBasis?: 'priced' | 'free' | 'unpriced';
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  status?: 'idle' | 'running' | 'done' | 'error' | 'interrupted';
  selected?: boolean;
  /** The run whose crew is shown — semibold title. */
  current?: boolean;
  onSelect?: () => void;
  style?: CSSProperties;
}

export declare function RunRow(props: RunRowProps): JSX.Element;
