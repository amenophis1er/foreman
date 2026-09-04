import type { CSSProperties, ReactNode } from 'react';

/** The only heading style below the app title: 11px, uppercase, 0.08em tracking, muted ink. */
export interface SectionTitleProps {
  children: ReactNode;
  style?: CSSProperties;
}

export declare function SectionTitle(props: SectionTitleProps): JSX.Element;
