import type { CSSProperties } from 'react';

export interface SetupCardProps {
  /** Fetches `GET /doctor`. */
  load: () => Promise<Response>;
  /** Opens Settings (the Provider section, ideally). */
  onSettings: () => void;
  /** Starts the Playwright Chromium install; the row shows `install` while it runs. */
  onInstallBrowser?: () => void;
  install?: { state: 'running' | 'done' | 'error'; progress: string; error?: string } | null;
  style?: CSSProperties;
}

/** The first-run card: the `foreman doctor` checks with state and one action each. */
export declare function SetupCard(props: SetupCardProps): JSX.Element;
