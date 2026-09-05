import type { CSSProperties } from 'react';

export interface DoneWhenItem { text: string; done: boolean; }

/**
 * The mission's DONE WHEN criteria as a live checklist, parsed from MISSION.md with the same
 * rule as the server's `unmetCriteria` — checkbox lines under the `DONE WHEN` heading, ending
 * at the next heading. Pinned beside the transcript so the finish line is always in view.
 */
export interface DoneWhenListProps {
  /** Raw MISSION.md markdown. Falsy → "MISSION.md not written yet." */
  doc?: string | null;
  style?: CSSProperties;
}

export declare function DoneWhenList(props: DoneWhenListProps): JSX.Element;
/** The criteria, or null when the doc has no DONE WHEN section (or no checkboxes in it). */
export declare function parseDoneWhen(doc: string | null | undefined): DoneWhenItem[] | null;
/** `Done when · 5 / 7`, or plain `Done when` for a null list. */
export declare function doneWhenLabel(items: DoneWhenItem[] | null): string;
