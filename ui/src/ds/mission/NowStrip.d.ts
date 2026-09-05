import type { CSSProperties } from 'react';

export interface NowApproval {
  id: string; agent: string; toolName?: string; title?: string;
  decisionReason?: string; input?: unknown; escapedPath?: string;
  /** Envelope ts of the ask — drives the `waiting 12m` line. */
  since?: number;
}
export interface NowQuestion { id: string; question: string; options?: string[]; since?: number; }

/** One line of what the crew is doing right now, shown when nothing is pending. */
export interface NowActivity {
  /** The latest worker `progress` status or the director's latest prose, one line. */
  line: string;
  /** Who said it — drives the identity dot. */
  agent?: string;
  /** `director · 2 workers`, right-aligned in muted ink. */
  crew?: string;
}

/**
 * The strip directly under the project header. Every pending approval and question renders
 * here as its full card, answerable in place, above everything else on the screen; when
 * nothing is pending and the run is live, one line of what the crew is doing now.
 * Renders nothing when idle with nothing pending.
 */
export interface NowStripProps {
  approvals?: NowApproval[];
  questions?: NowQuestion[];
  /** `Date.now()` from a ticking parent — the ages only move if something re-renders. */
  now?: number;
  /** The run is live; without it (and without asks) the strip is not rendered. */
  running?: boolean;
  activity?: NowActivity | null;
  onAllow?: (id: string) => void;
  onAlways?: (id: string) => void;
  onDeny?: (id: string) => void;
  onAnswer?: (id: string, answer: string) => void;
  style?: CSSProperties;
}

export declare function NowStrip(props: NowStripProps): JSX.Element | null;
/** "12m", "3h 4m", "45s"; empty string when `since` is missing. */
export declare function fmtAge(since: number | undefined, now: number): string;
/** The `waiting 12m` line in warning colour, or null. */
export declare function WaitingSince(props: { since?: number; now: number }): JSX.Element | null;
