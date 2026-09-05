import type { CSSProperties } from 'react';

/** Real token counts, unlike the dollar figure beside them — mirrors state.ts's TokenUsage. */
export interface BudgetMeterUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Live mission spend against its cap. 4px track, fill escalates brand → warning (triangle icon) at 70% → critical (octagon icon) at 90%.
 * The `$spent / $budget` text is always visible: the bar is redundant, never the only signal.
 *
 * When `metered` is false, `spent` is not real money (a local model, or an
 * external endpoint Foreman does not price) and is not rendered at all — the
 * component instead shows tokens and turns, and the track renders empty
 * rather than fabricate a fraction from caps it is not given.
 */
export interface BudgetMeterProps {
  /** Dollars spent so far. Rendered to 2 decimals. Ignored when `metered` is false. */
  spent: number;
  /** Dollar cap. Rendered with no decimals. Ignored when `metered` is false. */
  budget: number;
  /** False when `spent` is not real money. Defaults true (existing callers keep working). */
  metered?: boolean;
  /** Token counts to show in place of dollars when `metered` is false. */
  usage?: BudgetMeterUsage | null;
  /** Turn count to show alongside tokens when `metered` is false, and known. */
  turns?: number;
  style?: CSSProperties;
}

export declare function BudgetMeter(props: BudgetMeterProps): JSX.Element;

/** 12,345 -> "12.3k". Exported so callers building their own honest rows (RunDetails) don't re-derive it. */
export declare function formatTokens(n: number): string;
