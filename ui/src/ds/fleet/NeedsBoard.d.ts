import type { CSSProperties } from 'react';

/**
 * One pending ask on the board. Mirrors an entry of `needs[]` on
 * `GET /projects`, plus the project it belongs to.
 *
 * `summary` is the client's own fallback when the server sends no `needs`:
 * it carries counts as a sentence in `text` and can only be opened.
 */
export interface NeedItem {
  projectId: string;
  projectName: string;
  kind: 'permission' | 'question' | 'planner' | 'summary';
  /** Permission id, question id, or the planner ask id. Absent on `summary`. */
  id?: string;
  /** The run the ask belongs to; absent for the planner (and `summary`). */
  runId?: string;
  /** One line: what is wanted, or the question. Ellipsised by the strip. */
  text: string;
  /** Question/planner choices, the recommended one first; rendered as buttons. */
  options?: string[];
  toolName?: string;
  /** ms epoch; drives "waiting 3m". */
  since?: number;
}

/** Each handler resolves to an error message, or null on success. */
export interface NeedsBoardProps {
  items: NeedItem[];
  onPermission?: (item: NeedItem, behavior: 'allow' | 'deny') => Promise<string | null>;
  /** A director question: `text` is the choice or the typed line. */
  onAnswer?: (item: NeedItem, text: string) => Promise<string | null>;
  /** The planner's ask: answers only its first question — the strip's `text`. */
  onPlanner?: (item: NeedItem, text: string) => Promise<string | null>;
  onOpen?: (projectId: string) => void;
  style?: CSSProperties;
}

export declare function NeedsBoard(props: NeedsBoardProps): JSX.Element | null;

/** 3 minutes → "3m", 95 minutes → "1h 35m", two days → "2d". */
export declare function formatWait(sinceMs: number, now?: number): string;

/** "2 approvals, 1 question" — the fallback line when the server sends counts only. */
export declare function summaryText(counts: { approvals?: number; questions?: number; planner?: boolean }): string;
