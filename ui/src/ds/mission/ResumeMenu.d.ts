import type { CSSProperties } from 'react';
import type { ModelInfo } from '../forms/ModelSelect';

export interface ResumeMenuProps {
  /** The run's current models, pre-filled in the pickers. */
  director?: string;
  worker?: string;
  models?: ModelInfo[] | null;
  loading?: boolean;
  note?: string;
  busy?: boolean;
  /** Only the roles that changed are passed; a model without a providerId means the project's own provider. */
  onResume?: (on: { directorModel?: string; directorProviderId?: string; workerModel?: string; workerProviderId?: string }) => void;
  style?: CSSProperties;
}

/** "Resume on…": a button that opens a small panel with director and worker pickers, to resume a failed or interrupted run on other models without going through Settings. */
export declare function ResumeMenu(props: ResumeMenuProps): JSX.Element;
