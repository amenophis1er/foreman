import type { CSSProperties, ReactNode } from 'react';

/** The universal surface: 1px hairline, 6px radius, 12px padding, optional 3px left accent stripe. */
export interface CardProps {
  children: ReactNode;
  /** A color token string (`'var(--brand)'`, `'var(--agent-worker)'`, `'var(--status-critical)'`) rendered as a 3px left stripe. Identity or status only. */
  accent?: string;
  /** Which surface plane the card sits on. `card` is the default; `inset` for wells and payloads. */
  tone?: 'card' | 'panel' | 'inset';
  style?: CSSProperties;
  onClick?: () => void;
  title?: string;
}

export declare function Card(props: CardProps): JSX.Element;
