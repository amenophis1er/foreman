import type { CSSProperties } from 'react';

export interface DiffProps {
  /** Unified diff text as the server produced it. */
  text?: string;
  /** The server cut it at 400 lines; a trailing line says so. */
  truncated?: boolean;
  style?: CSSProperties;
}

/** A unified diff, one line per row: added lines on `--diff-add-bg`, deleted on `--diff-del-bg`, hunk and file headers in `--ink-2`. Scrolls sideways in its own box. */
export declare function Diff(props: DiffProps): JSX.Element;
