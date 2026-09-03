import type { CSSProperties, ReactNode } from 'react';

/**
 * Foreman's label pattern. Inline (default): label to the LEFT of its control, 6px gap, secondary ink, hint as tooltip.
 * Stacked: used only in the composer's parameter tray — uppercase 11px label above, visible one-line caption below.
 * No placeholders-as-labels and no required markers anywhere.
 */
export interface FieldProps {
  label: ReactNode;
  /** Inline → `title` tooltip. Stacked → visible caption under the control. Foreman explains consequences here. */
  hint?: string;
  layout?: 'inline' | 'stacked';
  children: ReactNode;
  style?: CSSProperties;
}

export declare function Field(props: FieldProps): JSX.Element;
