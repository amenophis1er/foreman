import type { CSSProperties } from 'react';
import type { Deck } from '../../deck';

/**
 * The Deck tab of the mission body: what the run changed (files with unified diffs) and what
 * it produced (screenshots and work files). Read-only — no edit, no delete, no terminal
 * (DESIGN.md §11). Feed it the result of `useDeck(runId, running)`.
 */
export interface DeckTabProps {
  runId: string;
  deck: Deck | null;
  /** First fetch in flight — shows "Reading the working tree…". */
  loading?: boolean;
  /** Server or transport error text. */
  error?: string | null;
  /** The endpoint 404'd: no deck for this run. Renders the empty state. */
  missing?: boolean;
  style?: CSSProperties;
}

export declare function DeckTab(props: DeckTabProps): JSX.Element;
