import type { CSSProperties } from 'react';

/**
 * Textarea with a live highlight overlay — the composer's Write mode. Colours `inline code`, ``` fenced blocks
 * (inset band, violet rule), > quotes, - list markers, # headings and <angle-bracket> slots as you type.
 * Auto-grows to `maxHeight`, then scrolls. Forwards its ref to the underlying `<textarea>` (selection APIs work).
 */
export interface RichEditorProps {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  /** Default 200 / 460. */
  minHeight?: number;
  maxHeight?: number;
  onKeyDown?: (e: any) => void;
  onPaste?: (e: any) => void;
  onFocus?: (e: any) => void;
  onBlur?: (e: any) => void;
  style?: CSSProperties;
}

export declare function RichEditor(props: RichEditorProps): JSX.Element;
