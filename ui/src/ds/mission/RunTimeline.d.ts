import type { CSSProperties } from 'react';

export interface TimelineEntry { id?: string | number; agent: string; ts: number; kind?: string; title?: string; }

/**
 * Swimlane view of a run (debt item 2): a lane per agent in its identity color, a translucent activity
 * span from first to last event, ticks per event (prose tall, tools short, errors red), and a pulsing
 * live edge on running agents. Clicking a lane label filters the transcript.
 */
export interface RunTimelineProps {
  /** `{ id, status }` objects or bare ids. Lane order follows this list. */
  agents?: Array<{ id: string; status?: string } | string>;
  entries: TimelineEntry[];
  /** Extend the axis to now (clamped to 60s past the last event) and show the live edge. */
  live?: boolean;
  /** Currently filtered agent — other lanes dim. */
  selected?: string | null;
  onSelect?: (agent: string) => void;
  /** Makes each tick a click target (widened hitbox) for jumping to its entry. */
  onTick?: (entry: TimelineEntry) => void;
  /** Lane height in px. 22 default; 32 for a full-height view. */
  height?: number;
  style?: CSSProperties;
}

export declare function RunTimeline(props: RunTimelineProps): JSX.Element | null;
