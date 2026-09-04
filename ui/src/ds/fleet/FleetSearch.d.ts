import type { CSSProperties } from 'react';

/**
 * Narrows the fleet grid. Sits between the header and the first card — quiet enough to ignore
 * on a small fleet, and the difference between glancing and hunting on a large one.
 */
export interface FleetSearchProps {
  /** Controlled query. The view owns it; matching is the view's business, not the field's. */
  value: string;
  onChange?: (v: string) => void;
  /** Matching projects, shown as `count of total` only while filtering. */
  count?: number;
  total?: number;
  style?: CSSProperties;
}

export declare function FleetSearch(props: FleetSearchProps): JSX.Element;
