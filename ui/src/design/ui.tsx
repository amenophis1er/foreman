// Design-system primitives. Components consume tokens only — no raw hex here
// except via CSS variables.
import type { CSSProperties, ReactNode } from 'react';

export type Status = 'idle' | 'running' | 'done' | 'error' | 'interrupted';

const STATUS_META: Record<Status, { color: string; icon: string; label: string }> = {
  idle:        { color: 'var(--ink-2)',            icon: '○', label: 'idle' },
  running:     { color: 'var(--status-good)',      icon: '●', label: 'running' },
  done:        { color: 'var(--status-good)',      icon: '✓', label: 'done' },
  error:       { color: 'var(--status-critical)',  icon: '✕', label: 'error' },
  interrupted: { color: 'var(--status-serious)',   icon: '⏸', label: 'interrupted' },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = STATUS_META[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-1)',
      fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
      padding: '2px 8px', borderRadius: 999,
      background: 'var(--bg-inset)', border: '1px solid var(--line)',
    }}>
      <span aria-hidden style={{ color: m.color }}>{m.icon}</span>
      {m.label}
    </span>
  );
}

export function Button({ children, onClick, variant = 'default', disabled, title, style }: {
  children: ReactNode; onClick?: () => void;
  variant?: 'default' | 'primary' | 'good' | 'danger';
  disabled?: boolean; title?: string; style?: CSSProperties;
}) {
  const variants: Record<string, CSSProperties> = {
    default: { background: 'var(--bg-card)', border: '1px solid var(--line-strong)', color: 'var(--ink-0)' },
    primary: { background: 'var(--brand)', border: '1px solid var(--brand)', color: 'var(--brand-ink)', fontWeight: 600 },
    good:    { background: 'transparent', border: '1px solid var(--status-good)', color: 'var(--ink-0)' },
    danger:  { background: 'transparent', border: '1px solid var(--status-critical)', color: 'var(--ink-0)' },
  };
  return (
    <button title={title} disabled={disabled} onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 'var(--r-sm)', cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1, ...variants[variant], ...style,
    }}>{children}</button>
  );
}

export function Card({ children, accent, style }: {
  children: ReactNode; accent?: string; style?: CSSProperties;
}) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--line)',
      borderLeft: accent ? `3px solid ${accent}` : '1px solid var(--line)',
      borderRadius: 'var(--r-sm)', padding: 'var(--sp-3)', ...style,
    }}>{children}</div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 style={{
      margin: '0 0 var(--sp-2)', fontSize: 'var(--fs-xs)', fontWeight: 600,
      textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-2)',
    }}>{children}</h2>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>{children}</div>;
}

/** Budget meter: value always visible as text (never color-alone), thin track,
 *  escalating status color with an icon once thresholds are crossed. */
export function BudgetMeter({ spent, budget }: { spent: number; budget: number }) {
  const frac = budget > 0 ? Math.min(spent / budget, 1) : 0;
  const level = frac >= 0.9 ? 'critical' : frac >= 0.7 ? 'warning' : 'ok';
  const barColor = level === 'critical' ? 'var(--status-critical)'
    : level === 'warning' ? 'var(--status-warning)' : 'var(--brand)';
  const icon = level === 'critical' ? '⚠ ' : level === 'warning' ? '△ ' : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 170 }}
      title={`$${spent.toFixed(2)} spent of $${budget.toFixed(2)} budget`}>
      <div style={{ flex: 1, height: 4, background: 'var(--bg-inset)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${frac * 100}%`, height: '100%', background: barColor, transition: 'width .3s' }} />
      </div>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', fontVariantNumeric: 'tabular-nums' }}>
        {icon}${spent.toFixed(2)} / ${budget.toFixed(0)}
      </span>
    </div>
  );
}

export function agentColor(agent: string): string {
  return agent === 'director' ? 'var(--brand)' : 'var(--agent-worker)';
}

export type AuthMode = 'api-key' | 'subscription' | 'cloud' | 'none';

const BILLING_META: Record<AuthMode, { icon: string; label: string; color: string; hint: string }> = {
  'api-key':     { icon: '$', label: 'API key billing', color: 'var(--status-warning)',
                   hint: 'Missions bill a metered API key, not a Claude subscription. Usage is charged per token.' },
  subscription:  { icon: '◐', label: 'subscription',    color: 'var(--ink-2)',
                   hint: 'Missions run on the signed-in Claude subscription.' },
  cloud:         { icon: '☁', label: 'cloud provider',  color: 'var(--ink-2)',
                   hint: 'Missions bill a cloud provider (Bedrock/Vertex).' },
  none:          { icon: '✕', label: 'no credentials',  color: 'var(--status-critical)',
                   hint: 'No credentials found — missions cannot run.' },
};

/**
 * States which account pays, wherever money is about to be spent.
 *
 * An API key in the server environment silently outranks a Claude subscription
 * login, so someone who believes they are spending plan quota can instead be
 * running up a metered bill. That case is the one that needs to be unmissable,
 * so it alone wears a status colour; the others stay muted. Icon + label always,
 * never colour alone.
 */
export function BillingBadge({ mode, source, compact }: {
  mode: AuthMode; source?: string; compact?: boolean;
}) {
  const m = BILLING_META[mode];
  return (
    <span title={source ? `${m.hint}\nSource: ${source}` : m.hint} style={{
      display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-1)',
      fontSize: compact ? 'var(--fs-xs)' : 'var(--fs-sm)', color: 'var(--ink-1)',
      padding: compact ? '1px 6px' : '2px 8px', borderRadius: 999,
      background: 'var(--bg-inset)', border: `1px solid ${mode === 'api-key' ? m.color : 'var(--line)'}`,
      whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{ color: m.color, fontWeight: 600 }}>{m.icon}</span>
      {compact ? m.label : `billing: ${m.label}`}
    </span>
  );
}
