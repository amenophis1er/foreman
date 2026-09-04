import type { CSSProperties } from 'react';

/**
 * Markdown-lite renderer for briefs and agent prose. Supported, and nothing else:
 * ``` fenced code (optional language tag) · `inline code` · > quotes · - lists · #/##/### headings · **bold** · <angle-bracket> slots.
 * Never renders raw HTML.
 */
export interface RichTextProps {
  text: string;
  /** Highlight `<angle-bracket>` template slots with a dashed gold pill. Default true; turn off for agent output. */
  slots?: boolean;
  style?: CSSProperties;
}

export declare function RichText(props: RichTextProps): JSX.Element;
