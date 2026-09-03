import type { CSSProperties } from 'react';

/** The two multi-line inputs in the product. Both resize vertically only. Forwards its ref to the `<textarea>`. */
export interface TextareaProps {
  value: string;
  onChange?: (v: string) => void;
  /** The composer placeholder is multi-line guidance, not a hint. */
  placeholder?: string;
  /** `mission` = composer brief (min 180px, card surface, 10px radius, 1.55 line-height) · `answer` = question reply (56px, inset surface, 6px radius) */
  size?: 'mission' | 'answer';
  /** No border/background/radius — for use inside an editor frame that draws its own. */
  bare?: boolean;
  onKeyDown?: (e: any) => void;
  onPaste?: (e: any) => void;
  onFocus?: (e: any) => void;
  onBlur?: (e: any) => void;
  style?: CSSProperties;
}

export declare function Textarea(props: TextareaProps): JSX.Element;
