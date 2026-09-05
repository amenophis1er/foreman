import type { CSSProperties } from 'react';

/** One row of `GET /models`. `id` is what the run API accepts; `model` is the exact model string shown in mono. */
export interface ModelInfo {
  id: string;
  label: string;
  model: string;
  /** 1–4 relative cost, drawn as a four-bar mark. */
  cost?: 1 | 2 | 3 | 4;
  /** One line of guidance shown under the label. */
  note?: string;
}

/** Custom listbox picker for an agent role. `''` means "inherit your Claude Code default". */
export interface ModelSelectProps {
  value?: string;
  onChange?: (id: string) => void;
  /** From `ModelSelect.useModels('/models')`. Omit to use `FALLBACK_MODELS` (fable/opus/sonnet/haiku). */
  models?: ModelInfo[] | null;
  /** Shows "Fetching models…" and disables the trigger. */
  loading?: boolean;
  /** Line shown at the top of the listbox — why the list is short or empty
   *  (an unreachable endpoint reads differently from one with nothing pulled). */
  note?: string;
  /** What the "Default" row inherits from, when it is not a Claude Code
   *  install — e.g. `the provider's default model`. */
  inheritNote?: string;
  /** Include the leading "Default" (inherit) row. Default true. */
  allowDefault?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
}

export declare function ModelSelect(props: ModelSelectProps): JSX.Element;
export declare namespace ModelSelect {
  /** Load the list once from a URL (`{models: ModelInfo[]}`) or an async function. Pass a stable reference. */
  function useModels(source?: string | (() => Promise<ModelInfo[]>)): { models: ModelInfo[] | null; loading: boolean; error: string | null };
}
export declare const FALLBACK_MODELS: ModelInfo[];
