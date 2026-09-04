import type { CSSProperties } from 'react';

/**
 * Live mission spend against its cap. 4px track, fill escalates brand → warning (triangle icon) at 70% → critical (octagon icon) at 90%.
 * The `$spent / $budget` text is always visible: the bar is redundant, never the only signal.
 */
export interface BudgetMeterProps {
  /** Dollars spent so far. Rendered to 2 decimals. */
  spent: number;
  /** Dollar cap. Rendered with no decimals. */
  budget: number;
  style?: CSSProperties;
}

export declare function BudgetMeter(props: BudgetMeterProps): JSX.Element;
