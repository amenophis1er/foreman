import type { CSSProperties } from 'react';

export interface TabItem {
  value: string;
  label: string;
  /** Semantic icon name. */
  icon?: string;
  /** Numeric badge; hidden when 0. */
  count?: number;
  /** Render the count badge in warning color (pending approvals/questions). */
  attention?: boolean;
}

/** Segmented view switcher. Selected tab lifts to the card surface; it is not navigation. */
export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange?: (value: string) => void;
  size?: 'md' | 'sm';
  style?: CSSProperties;
}

export declare function Tabs(props: TabsProps): JSX.Element;
