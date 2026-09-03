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
