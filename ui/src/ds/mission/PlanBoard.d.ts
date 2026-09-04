import type { CSSProperties } from 'react';

/**
 * The plan board: the mission's checklist, read live out of `.foreman/MISSION.md` (5s poll).
 * The document is the source of truth — this is a view of it, not a task store.
 */
export interface PlanBoardProps {
  /** Raw MISSION.md markdown. Falsy → "MISSION.md not written yet." */
  doc?: string;
  style?: CSSProperties;
}

export declare function PlanBoard(props: PlanBoardProps): JSX.Element;
/** Extracts `{ text, done }` items from markdown checkboxes. */
export declare function parsePlan(doc: string): { text: string; done: boolean }[];
/** Bundle-reachable alias. */
export declare const ParsePlan: typeof parsePlan;
