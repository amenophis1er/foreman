import type { CSSProperties } from 'react';

/**
 * Foreman's icon system: Lucide (1.75px stroke) behind a semantic name map, so call sites say
 * what an icon means, not what it looks like. Always sits beside a text label unless `label` is given.
 */
export interface IconProps {
  /** A semantic key from `ICONS` (`'running'`, `'needsYou'`, `'Bash'`) or any raw Lucide PascalCase name. */
  name: string;
  /** 14 in badges/meta, 16 in buttons/rows (default), 20 in header icon buttons. */
  size?: number;
  strokeWidth?: number;
  /** Defaults to `currentColor`. Pass a status/identity token only when the icon is the colored element. */
  color?: string;
  /** Accessible name — only for icon-only controls; otherwise the adjacent text is the label. */
  label?: string;
  style?: CSSProperties;
}

export declare function Icon(props: IconProps): JSX.Element;
/** Semantic → Lucide name map. Extend here, never inline. */
export declare const ICONS: Record<string, string>;
