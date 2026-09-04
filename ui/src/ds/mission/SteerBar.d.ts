import type { CSSProperties } from 'react';

export interface SteerAgent { id: string; status?: string; task?: string }

/**
 * Unsolicited guidance to a live agent — a constraint, correction or hint the agent did not ask for.
 * Docked at the bottom of the transcript column while the run is live. Sent notes appear in the transcript as `kind="steer"` entries.
 */
export interface SteerBarProps {
  /** Crew list; recipients are the director plus any running worker. */
  agents?: SteerAgent[];
  /** Controlled recipient id. Defaults to `director`. */
  to?: string;
  onTo?: (id: string) => void;
  /** Controlled draft text. Omit to let the bar hold its own draft. */
  value?: string;
  onChange?: (v: string) => void;
  /** `next` (default) queues the note before the agent's next tool call · `now` interrupts the current tool call and injects it. */
  timing?: 'next' | 'now';
  onTiming?: (t: 'next' | 'now') => void;
  /** Fires on Send / ⌘↵ with the trimmed text and its routing. */
  onSend?: (text: string, meta: { to: string; timing: 'next' | 'now' }) => void;
  /** Nothing is running. The bar stays visible but inert so the affordance is learnable. */
  disabled?: boolean;
  /** Placeholder shown while disabled, e.g. "Run finished — start a new mission." */
  disabledReason?: string;
  style?: CSSProperties;
}

export declare function SteerBar(props: SteerBarProps): JSX.Element;
