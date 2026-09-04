import type { CSSProperties, ReactNode } from 'react';

/** Foreman's only button. Variant carries intent, never size or importance alone. */
export interface ButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  /** default = neutral action · primary = brand-filled, one per view · good = affirm (Allow, Resume, Create) · danger = destructive (Interrupt, Deny, Unlink) · ghost = quiet text action (unlink, raw, collapse) */
  variant?: 'default' | 'primary' | 'good' | 'danger' | 'ghost';
  /** `md` (default) · `sm` for chips, inline toggles, table actions */
  size?: 'md' | 'sm';
  /** Leading icon, semantic name from `ICONS` (`'resume'`, `'back'`, `'add'`). */
  icon?: string;
  disabled?: boolean;
  /** Tooltip — used generously in Foreman to explain consequences. */
  title?: string;
  type?: 'button' | 'submit';
  style?: CSSProperties;
}

export declare function Button(props: ButtonProps): JSX.Element;
