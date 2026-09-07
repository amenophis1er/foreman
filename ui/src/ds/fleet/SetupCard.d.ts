import type { CSSProperties } from 'react';

export interface SetupCardProps {
  /** Fetches `GET /doctor`. */
  load: () => Promise<Response>;
  /** Opens Settings (the Provider section, ideally). */
  onSettings: () => void;
  style?: CSSProperties;
}

/** The first-run card: the `foreman doctor` checks with state and one action each. */
export declare function SetupCard(props: SetupCardProps): JSX.Element;
