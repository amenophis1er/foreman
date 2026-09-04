import type { CSSProperties, ReactNode } from 'react';

/**
 * Foreman's system messaging. There are no toasts: a condition is either a strip under the
 * header (persistent, e.g. read-only replay) or an inline line beside the control that caused it.
 */
export interface BannerProps {
  /** `readonly` (History icon, warning) · `disconnected` (WifiOff, serious) · `error` (X, critical) · `caution` (TriangleAlert, serious) */
  tone?: 'readonly' | 'disconnected' | 'error' | 'caution';
  children: ReactNode;
  /** Render as an inline colored line (composer errors, header 409s) instead of a full-width strip. */
  inline?: boolean;
  style?: CSSProperties;
}

export declare function Banner(props: BannerProps): JSX.Element;
