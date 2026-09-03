import type { CSSProperties } from 'react';

/** A blocked director asking the human to decide. Gold-accented, with a reply box and one primary action. */
export interface QuestionCardProps {
  /** The director's question, verbatim. Whitespace is preserved. */
  question: string;
  /** Controlled answer text. Omit to let the card hold its own draft. */
  value?: string;
  onChange?: (v: string) => void;
  onAnswer?: (answer: string) => void;
  style?: CSSProperties;
}

export declare function QuestionCard(props: QuestionCardProps): JSX.Element;
