import type { CSSProperties, ReactNode } from 'react';

/** One event in the centre column. The transcript is a flat, chronological list of these. */
export interface TranscriptEntryProps {
  /** Agent id — drives the identity dot and, for `text` entries, the left accent. */
  agent: string;
  /** Event label. For `kind="tool"` this is the tool name (`Write`, `spawn_worker`) and drives the ToolCall chip. */
  title?: string;
  /** `text` = agent prose (identity accent) · `tool` = structured ToolCall · `result` = mono, no accent · `system` = muted · `error` = critical accent · `steer` = operator note to an agent (ink accent, `you → to · timing` header) */
  kind?: 'text' | 'tool' | 'result' | 'system' | 'error' | 'steer';
  /** Prose, or for tools the JSON payload string. */
  body?: ReactNode;
  /** Epoch ms; rendered HH:MM:SS, 24-hour. */
  ts?: number;
  /** `steer` only: recipient agent id. */
  to?: string;
  /** `steer` only: how it was delivered. */
  timing?: 'next' | 'now';
  style?: CSSProperties;
}

export declare function TranscriptEntry(props: TranscriptEntryProps): JSX.Element;
