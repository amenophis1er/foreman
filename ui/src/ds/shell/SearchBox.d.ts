import type { CSSProperties, ReactNode } from 'react';

export interface SearchItem {
  id: string;
  title: ReactNode;
  detail?: ReactNode;
  /** Right-aligned: a date, a cost. */
  meta?: ReactNode;
  status?: 'idle' | 'running' | 'done' | 'error' | 'interrupted' | 'needs-you';
  /** Icon name; defaults to `folder`. */
  icon?: string;
  onPick?: () => void;
}

export interface SearchGroup {
  label: string;
  /** Shown after the label when the list is truncated. */
  count?: number;
  items: SearchItem[];
}

/** The header's finder: projects, runs across the fleet, and actions, from any screen. `/` or ⌘K focuses it. */
export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  groups?: SearchGroup[];
  placeholder?: string;
  /** A fetch is in flight; an empty list is not yet "nothing matches". */
  busy?: boolean;
  style?: CSSProperties;
}

export declare function SearchBox(props: SearchBoxProps): JSX.Element;
