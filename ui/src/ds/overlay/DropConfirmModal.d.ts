import type { ReactNode } from 'react';

/**
 * Drag-and-drop linking, second half. A dropped folder gives up only its name, so the server searches
 * `$HOME` and this modal asks the human which absolute path they meant.
 */
export interface DropConfirmModalProps {
  /** The dropped folder's name — all the browser will tell us. */
  name: string;
  /** Candidate absolute paths. `null`/`undefined` = still searching; `[]` = no match. */
  matches?: string[] | null;
  onPick?: (path: string) => void;
  onClose?: () => void;
}

export declare function DropConfirmModal(props: DropConfirmModalProps): JSX.Element;
/** The gold dashed drop target shown over the fleet while dragging. */
export declare function DropOverlay(props: { children?: ReactNode }): JSX.Element;
