import type { CSSProperties } from 'react';

/** Foreman lockup: the F mark beside the word. Use in the fleet header, the thumbnail, and any title slide. */
export interface LogoProps {
  /** Mark size in px; the word scales with it. 22 in the app header. */
  size?: number;
  /** Optional muted text after the word — the product's own is `mission control`. */
  tagline?: string;
  /** Single-color version (inherits `color`) for print, favicons, and on-brand surfaces. */
  mono?: boolean;
  style?: CSSProperties;
}

export declare function Logo(props: LogoProps): JSX.Element;

/** The mark alone. Never distort; minimum 16px. */
export interface LogoMarkProps {
  size?: number;
  mono?: boolean;
  style?: CSSProperties;
}

export declare function LogoMark(props: LogoMarkProps): JSX.Element;
