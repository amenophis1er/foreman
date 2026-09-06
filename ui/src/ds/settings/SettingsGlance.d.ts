import type { CSSProperties } from 'react';
import type { Settings } from './SettingsModal';

export interface SettingsGlanceProps {
  /** Defaults ← global ← project, already merged. */
  effective?: Settings;
  /** Keys the project sets itself; these rows carry an "override" mark. */
  overrides?: string[];
  /** Opens Settings on the project scope. */
  onOpen?: () => void;
  style?: CSSProperties;
}

/** The project's effective settings at a glance in the rail — models, budget, approvals — with the project's own overrides marked and one button to the place they are edited. */
export declare function SettingsGlance(props: SettingsGlanceProps): JSX.Element;
