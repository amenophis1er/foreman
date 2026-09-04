import type { CSSProperties } from 'react';

export type BillingMode = 'api-key' | 'subscription' | 'cloud' | 'none';

/**
 * Says which account pays for a mission. Sits in the fleet header, the project
 * header, and directly beneath Start mission — anywhere money is about to be spent.
 *
 * Only `api-key` and `none` wear a coloured ring. Believing you are on a
 * subscription while billing a metered key is the expensive mistake; the reverse
 * is harmless. Colouring every mode would train people to ignore all of them.
 */
export interface BillingBadgeProps {
  /** api-key (metered) · subscription · cloud (Bedrock/Vertex) · none (blocks missions) */
  mode: BillingMode;
  /** Where the credential came from; shown in the tooltip, e.g. `ANTHROPIC_API_KEY`. */
  source?: string;
  /**
   * Which Claude account is signed in. When present its email replaces the mode
   * word in the label — on a machine with several logins, "subscription" alone
   * does not say who pays, which is the only thing worth showing.
   */
  account?: { email?: string; org?: string };
  /** Drops the `billing:` prefix and tightens padding, for dense rows. */
  compact?: boolean;
  style?: CSSProperties;
}

export declare function BillingBadge(props: BillingBadgeProps): JSX.Element;
/** The glyph + label + colour for each mode, if you need to render one inline. */
export declare const BILLING_META: Record<string, { color: string; icon: string; label: string; hint: string }>;
