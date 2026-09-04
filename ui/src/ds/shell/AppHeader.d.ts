import type { CSSProperties, ReactNode } from 'react';

/** The single header bar, in its two modes. Panel surface, hairline bottom, never sticky-shadowed. */
export interface AppHeaderProps {
  /** `fleet` = logo lockup + tagline · `project` = ← Fleet button, project name, mono folder */
  mode?: 'fleet' | 'project';
  /** Project name in project mode (fleet mode always shows the logo). */
  title?: string;
  /** Fleet mode only. The product's own tagline is `mission control`. */
  subtitle?: string;
  /** Project mode only: absolute folder path, mono, under the name. */
  folder?: string;
  onBack?: () => void;
  /** Current theme; with `onToggleTheme`, renders the sun/moon IconButton at the far right. */
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
  /** Renders the gear IconButton at the far right; opens `SettingsModal`. */
  onSettings?: () => void;
  /** Right-aligned slot: status badge, budget meter, contextual actions, inline errors. */
  children?: ReactNode;
  style?: CSSProperties;
}

export declare function AppHeader(props: AppHeaderProps): JSX.Element;
