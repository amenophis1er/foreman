import type { ReactNode } from 'react';

/** One line of muted 12px text standing in for absent content. No icon, no illustration, no button. */
export interface EmptyProps {
  children: ReactNode;
}

export declare function Empty(props: EmptyProps): JSX.Element;
