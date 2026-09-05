import type { CSSProperties } from 'react';

/** One row of `GET /models`. `id` is what the run API accepts; `model` is the exact model string shown in mono. */
export interface ModelInfo {
  id: string;
  label: string;
  model: string;
  /** Which provider serves it. Absent means Anthropic — the server default, and what FALLBACK_MODELS and the inherit row implicitly are. */
  providerId?: string;
  /** Display name for the group heading and the trigger's provider tag. Absent is treated as `'Anthropic'`. */
  providerLabel?: string;
  /** 0–4 relative cost, drawn as a four-bar mark. 0 or absent renders as "—". */
  cost?: 0 | 1 | 2 | 3 | 4;
  /** One line of guidance shown under the label — where it runs and what it costs. Never reconstructed client-side, so an unmetered row can't grow a dollar figure it doesn't have. */
  note?: string;
  /** Whether spending on it is real money Foreman can price. Informational only here — the note already says so; ModelSelect never invents cost language from this flag. */
  metered?: boolean;
}

/** Custom listbox picker for an agent role. `''` means "inherit your Claude Code default". */
export interface ModelSelectProps {
  value?: string;
  /** `model` is the full row that was clicked (or the inherit row), so a caller can persist `providerId` alongside `id`. Extra arg — callers that only read `id` keep working unchanged. */
  onChange?: (id: string, model?: ModelInfo) => void;
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
  align?: 'left' | 'right';
  style?: CSSProperties;
}

export declare function ModelSelect(props: ModelSelectProps): JSX.Element;
export declare namespace ModelSelect {
  /** Load the list once from a URL (`{models: ModelInfo[]}`) or an async function. Pass a stable reference. */
  function useModels(source?: string | (() => Promise<ModelInfo[]>)): { models: ModelInfo[] | null; loading: boolean; error: string | null };
}
export declare const FALLBACK_MODELS: ModelInfo[];
