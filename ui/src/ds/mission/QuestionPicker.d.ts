import type { CSSProperties } from 'react';

/** One option the planner offered. The first in a list is the recommended one. */
export interface PickerOption {
  label: string;
  /** One line under the label: what choosing this implies. */
  hint?: string;
}

/** One structured question. Mirrors `AskQuestion` in src/ask.ts. */
export interface PickerQuestion {
  question: string;
  options: PickerOption[];
  /** Several answers may be chosen; they are sent joined with ", ". */
  multi?: boolean;
}

/**
 * Replaces the ChatBar while the planner is parked on an `ask_user` call.
 *
 * Answers are keyed by question text — the same keys the server hands back to
 * the planner — so transcript, picker and model all agree on what was chosen.
 * One single-choice question answers on click; anything more needs one
 * explicit Send. Typing free text answers the focused question and sends
 * whatever else was picked, so the planner is never left waiting on the rest.
 */
export interface QuestionPickerProps {
  questions: PickerQuestion[];
  /** When the planner asked; shows `waiting Nm` once a minute has passed. */
  askedAt?: number;
  /** Who is asking — echoed under the picker so the answer goes to a known model. */
  who?: { model: string; provider: string; costBasis: 'priced' | 'free' | 'unpriced' } | null;
  /** Fires once with every answer collected. The picker disables itself afterwards. */
  onAnswer?: (answers: Record<string, string>) => void;
  /** Unused today; kept so a host can route typed text elsewhere if it must. */
  onFreeText?: (text: string) => void;
  style?: CSSProperties;
}

export declare function QuestionPicker(props: QuestionPickerProps): JSX.Element;
