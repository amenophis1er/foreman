import React from 'react';
import { Icon } from '../core/Icon';

export const BILLING_META = {
  'api-key': {
    color: 'var(--status-warning)', icon: 'budget', label: 'API key billing',
    hint: 'Missions bill a metered API key, not a Claude subscription. Usage is charged per token.',
  },
  subscription: {
    color: 'var(--ink-2)', icon: 'budget', label: 'subscription',
    hint: 'Missions run on the signed-in Claude subscription.',
  },
  cloud: {
    color: 'var(--ink-2)', icon: 'budget', label: 'cloud provider',
    hint: 'Missions bill a cloud provider (Bedrock/Vertex).',
  },
  none: {
    color: 'var(--status-critical)', icon: 'error', label: 'no credentials',
    hint: 'No credentials found — missions cannot run.',
  },
};

/**
 * States which account pays, wherever money is about to be spent.
 *
 * An API key in the server environment silently outranks a Claude subscription
 * login, so someone who believes they are spending plan quota can instead run up
 * a metered bill. That case alone wears a status colour and a ring; the others
 * stay muted, because making every mode loud teaches people to ignore all of
 * them. Icon and label always — never colour alone.
 */
export function BillingBadge({ mode, source, account, compact, style }) {
  const m = BILLING_META[mode] ?? BILLING_META.none;
  // "subscription" alone cannot answer "whose?" — and on a machine with more
  // than one Claude login that is the only question worth asking.
  const who = account?.email;
  const label = who ?? m.label;
  const title = [m.hint, who && account.org ? `Account: ${who} (${account.org})` : who && `Account: ${who}`,
    source && `Source: ${source}`].filter(Boolean).join('\n');
  const loud = mode === 'api-key' || mode === 'none';
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: compact ? 'var(--fs-xs)' : 'var(--fs-sm)', color: 'var(--ink-1)',
      padding: compact ? '1px 6px 1px 5px' : '2px 8px 2px 6px',
      borderRadius: 'var(--r-pill)', background: 'var(--bg-inset)',
      border: `1px solid ${loud ? m.color : 'var(--line)'}`,
      whiteSpace: 'nowrap', lineHeight: '16px', ...style,
    }}>
      <Icon name={m.icon} size={12} strokeWidth={2.25} color={m.color} />
      {compact ? label : `billing: ${label}`}
    </span>
  );
}
