import type { CSSProperties, ReactNode } from 'react';

/** One event in the centre column. The transcript is a flat, chronological list of these. */
export interface TranscriptEntryProps {
  /** Agent id — drives the identity dot and, for `text` entries, the left accent. */
  agent: string;
  /** Event label. For `kind="tool"` this is the tool name (`Write`, `spawn_worker`) and drives the ToolCall chip. */
  title?: string;
  /** `text` = agent prose (identity accent) · `tool` = structured ToolCall · `result` = mono, no accent · `system` = muted · `error` = critical accent · `steer` = operator note to an agent (ink accent, `you → to · timing` header) · `review` = a reviewer's verdict card (needs `review`) */
  kind?: 'text' | 'tool' | 'result' | 'system' | 'error' | 'steer' | 'review';
  /** Prose, or for tools the JSON payload string. */
  body?: ReactNode;
  /** Epoch ms; rendered HH:MM:SS, 24-hour. */
  ts?: number;
  /** `steer` only: recipient agent id. */
  to?: string;
  /** `steer` only: how it was delivered. */
  timing?: 'next' | 'now';
  /**
   * `kind="tool"` only: render as one quiet mono line (dot · icon · tool · first 90 chars of
   * the args · time) with no card chrome. Other kinds ignore it and stay cards. The live
   * transcript sets this so decisions and asks outweigh the tool churn between them.
   */
  dense?: boolean;
  /**
   * `kind="review"` only: one crew reviewer's verdict on the run's diff.
   * Read-only by design — a preset is standing configuration, edited in
   * Settings, and a verdict is a record of what happened.
   */
  review?: {
    /** The preset that produced it. */
    presetId?: string;
    /** The reviewer's name, as configured. */
    name: string;
    pass: boolean;
    /** Markdown-ish; folded behind "Show all" past ~12 lines. */
    findings?: string;
    model?: string;
    costUsd?: number;
    diffHash?: string;
    workerId?: string;
  };
  /** `kind="review"` only: a verdict prints a dollar ONLY when this is `priced`. */
  costBasis?: 'priced' | 'free' | 'unpriced';
  style?: CSSProperties;
}

export declare function TranscriptEntry(props: TranscriptEntryProps): JSX.Element;
