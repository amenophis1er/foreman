import type { CSSProperties, ReactNode, RefObject } from 'react';

/** Panel-surface scroll column. The wide mission workspace is `250px 1fr 340px`: left Rail, transcript, right Rail. */
export interface RailProps {
  /** Which edge gets the hairline. `left` → border-right; `right` → border-left. */
  side?: 'left' | 'right';
  /** Usually `var(--rail-left)` (250px) or `var(--rail-right)` (340px); omit inside a grid that sizes it. */
  width?: number | string;
  children: ReactNode;
  style?: CSSProperties;
}

export declare function Rail(props: RailProps): JSX.Element;

/**
 * Responsive tier for the project view (debt item 10). Observes `el` (or the window):
 * `wide` ≥ 1180px → three columns · `medium` ≥ 900px → transcript + right rail, crew as a strip · `narrow` → single column with Tabs.
 */
export declare function useLayoutTier(el?: RefObject<HTMLElement>): 'wide' | 'medium' | 'narrow';
/** Bundle-reachable alias: `LayoutTier.use(ref)` (only PascalCase names are exposed on the window namespace). */
export declare const LayoutTier: { use: typeof useLayoutTier; WIDE: 1180; NARROW: 900 };
