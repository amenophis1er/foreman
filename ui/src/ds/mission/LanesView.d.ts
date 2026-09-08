import type { CSSProperties } from 'react';
import type { AgentInfo, Entry } from '../../state';
type TranscriptOrder = 'newest' | 'oldest';

export interface LanesViewProps {
  agents: AgentInfo[];
  entries: Entry[];
  /** The run's worker records, for cost per lane. */
  workers?: Array<{ id: string; status: string; costUsd: number; task?: string }>;
  /** Agent ids shown as lanes, in order. */
  lanes: string[];
  onLanes: (lanes: string[]) => void;
  order?: TranscriptOrder;
  live?: boolean;
  /** An entry to scroll to and flash (from a timeline click); `n` re-fires on repeat. */
  jump?: { id: number; n: number } | null;
  style?: CSSProperties;
}

/** The transcript as one column per agent on a shared, bucketed time axis; finished agents fold into a dropdown. */
export declare function LanesView(props: LanesViewProps): JSX.Element;
/** Bucket width for a run's span: 1, 5, 15 or 60 minutes. */
export declare function bucketMsFor(spanMs: number): number;
