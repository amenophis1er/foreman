import type { CSSProperties } from 'react';

/** A project with nothing running, in the board's "Recent" grid: name, last outcome, unlink on hover. */
export interface OutcomeTileProps {
  name: string;
  /** Absolute path; shortened and mono, right of the name. */
  folder: string;
  /** The most recent finished run. Absent → "No missions yet — open to compose one." */
  lastRun?: {
    mission: string;
    title?: string;
    status: 'idle' | 'running' | 'done' | 'error' | 'interrupted';
    createdAt?: number;
    costUsd?: number;
    /**
     * The tile prints a dollar ONLY when this is `priced`. Otherwise tokens
     * from `usage`, or nothing. An absent basis is not priced.
     */
    costBasis?: 'priced' | 'free' | 'unpriced';
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    /**
     * The reviewers whose PASS let this run be recorded done, by name, decided
     * by the server. Non-empty (with `status: 'done'`) draws the reviewed
     * mark; the tile applies no rule of its own. Absent or empty on a run
     * nothing required a review of.
     */
    reviewedBy?: string[];
  } | null;
  onOpen?: () => void;
  /** Should open a ConfirmDialog — unlinking is not a one-click action. */
  onUnlink?: () => void;
  style?: CSSProperties;
}

export declare function OutcomeTile(props: OutcomeTileProps): JSX.Element;
