import type { CSSProperties } from 'react';

/** Boolean control for settings rows. Never used for actions — that is a Button. */
export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name; the visible label lives in the surrounding row. */
  label?: string;
  size?: 'sm' | 'md';
  style?: CSSProperties;
}

export declare function Switch(props: SwitchProps): JSX.Element;
