import type { CSSProperties } from 'react';

/**
 * Links a folder as a project. Browses the real filesystem server-side, so it shows absolute paths
 * and excludes hidden directories. This is the entire setup flow for a project.
 */
export interface FolderPickerProps {
  /** Absolute path of the directory being viewed — rendered mono in brand gold. */
  path?: string;
  /** Parent path, or null at the root. Renders the `..` row with a corner-up icon. */
  parent?: string | null;
  /** Immediate subdirectory names (hidden ones already filtered out). */
  dirs?: string[];
  /** Validation error from a create attempt (traversal, hidden name). */
  error?: string;
  onNavigate?: (path: string) => void;
  /** Create a subfolder here, then navigate into it ready to select. */
  onCreate?: (name: string) => void;
  onPick?: (path: string) => void;
  /** Clone a Git URL under the projects root and link it. Present = the dialog offers the URL field. */
  onClone?: (url: string, branch?: string) => void;
  /** The clone in flight or just finished, for the progress line and the error. */
  clone?: { state: 'running' | 'done' | 'error'; progress?: string; error?: string; dest?: string } | null;
  onClose?: () => void;
  style?: CSSProperties;
}

export declare function FolderPicker(props: FolderPickerProps): JSX.Element;
