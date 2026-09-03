import type { ReactNode } from 'react';

/** Small modal that states the consequence before a destructive action (debt item 8). */
export interface ConfirmDialogProps {
  /** Question form: `Unlink Alpha?` */
  title: ReactNode;
  /** What happens and what does not: `Foreman stops tracking this folder. Run history is kept.` */
  body: ReactNode;
  /** The verb, matching the title: `Unlink`. */
  confirmLabel?: string;
  /** `danger` outline (default) or `primary`. */
  tone?: 'danger' | 'primary' | 'good';
  /** Semantic icon beside the title. */
  icon?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

export declare function ConfirmDialog(props: ConfirmDialogProps): JSX.Element;
