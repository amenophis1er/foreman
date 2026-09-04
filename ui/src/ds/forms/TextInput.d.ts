import type { CSSProperties, ReactNode } from 'react';

/** Single-line input — budget amounts, new folder names. 6px/9px padding, `--bg-card` on `--line-strong`. */
export interface TextInputProps {
  value: string | number;
  onChange?: (v: any) => void;
  placeholder?: string;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  step?: number;
  /** Fixed pixel width; omit to fill the row (`100%`). The budget input is 96 with a `$` prefix. */
  width?: number;
  /** Render the value in `--font-mono` (paths, ids). */
  mono?: boolean;
  /** Fixed glyph inside the box, before the value — `$` on the budget cap. */
  prefix?: ReactNode;
  autoFocus?: boolean;
  onKeyDown?: (e: any) => void;
  style?: CSSProperties;
}

export declare function TextInput(props: TextInputProps): JSX.Element;
