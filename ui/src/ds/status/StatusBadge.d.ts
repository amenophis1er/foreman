import type { CSSProperties } from 'react';

/**
 * The run/agent status pill. The glyph wears the status color; the text stays `--ink-1`.
 * Status is NEVER communicated by color alone anywhere in Foreman — this component is the reason why.
 */
export interface StatusBadgeProps {
  /**
   * idle (Circle) · running (Activity) · done (Check) · error (X) · interrupted (Pause)
   * · needs-you (Bell, `--status-warning`) — a running run blocked on an approval or question.
   */
  status: 'idle' | 'running' | 'done' | 'error' | 'interrupted' | 'needs-you';
  style?: CSSProperties;
}

export declare function StatusBadge(props: StatusBadgeProps): JSX.Element;
/** The glyph + label + color for each status, if you need to render one inline. */
export declare const STATUS_META: Record<string, { color: string; icon: string; label: string }>;
