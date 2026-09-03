import type { CSSProperties } from 'react';

/** Icon-only button for chrome actions (theme, collapse, dismiss). Never for primary or destructive actions. */
export interface IconButtonProps {
  /** Semantic icon name from `ICONS`. */
  icon: string;
  /** Required accessible name; also the tooltip. */
  label: string;
  onClick?: () => void;
  /** Pressed/toggled look — card surface with a strong hairline. */
  active?: boolean;
  /** `md` 32px · `sm` 26px */
  size?: 'md' | 'sm';
  disabled?: boolean;
  style?: CSSProperties;
}

export declare function IconButton(props: IconButtonProps): JSX.Element;
