import type { CSSProperties } from 'react';

/** Token counts as the orchestrator accumulates them. */
export interface MeterUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Mirrors `CostBasis` in src/types.ts. */
export type CostBasis = 'priced' | 'free' | 'unpriced';

/** 12,345 -> "12.3k". Exported because token counts appear outside the meter too. */
export declare function formatTokens(n: number): string;

export interface BudgetMeterProps {
  /**
   * Dollars spent so far. Rendered to 2 decimals, and ONLY when `costBasis`
   * is `priced` — on any other basis the figure is Anthropic's price table
   * applied to somebody else's tokens, and is ignored entirely.
   */
  spent?: number;
  /** Dollar cap. Rendered with no decimals. Ignored unless `costBasis` is `priced`. */
  budget?: number;
  /**
   * What the spend is.
   *
   * `priced` fills the track and prints dollars. `free` shows an empty track
   * and token counts — nothing is being spent. `unpriced` shows a *striped*
   * track and the same counts: something is being spent, of an amount nobody
   * here can state. The last two must never render identically; that
   * conflation is what the boolean this replaced got wrong.
   */
  costBasis?: CostBasis;
  /** Token counts to show in place of dollars when `costBasis` is not `priced`. */
  usage?: MeterUsage | null;
  /** Turn count to show alongside tokens when not `priced`, and known. */
  turns?: number;
  style?: CSSProperties;
}

export declare function BudgetMeter(props: BudgetMeterProps): JSX.Element;
