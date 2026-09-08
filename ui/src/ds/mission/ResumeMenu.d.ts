import type { CSSProperties } from 'react';
import type { ModelInfo } from '../forms/ModelSelect';

export interface ResumeMenuProps {
  /** The run's current models, pre-filled in the pickers. */
  director?: string;
  worker?: string;
  /** The run's current cap and spend; with a cap the panel offers a budget row (+$5, +$10, ×2). */
  budget?: number;
  spent?: number;
  models?: ModelInfo[] | null;
  loading?: boolean;
  note?: string;
  busy?: boolean;
  /** `{}` from the wide half means "resume as is"; from the panel, only the roles that changed are passed. A model without a providerId means the project's own provider. */
  onResume?: (on: { directorModel?: string; directorProviderId?: string; workerModel?: string; workerProviderId?: string; budgetUsd?: number }) => void;
  style?: CSSProperties;
}

/** The Resume split button: the wide half resumes as is, the caret opens a panel with director and worker pickers to resume on other models without going through Settings. */
export declare function ResumeMenu(props: ResumeMenuProps): JSX.Element;
