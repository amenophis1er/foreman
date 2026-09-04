import React from 'react';

/** The Foreman mark: a gold F whose middle arm is worker violet — the director's stem, the crew's reach. */
export function LogoMark({ size = 24, mono, style }) {
  const gold = mono ? 'currentColor' : 'var(--brand)';
  const violet = mono ? 'currentColor' : 'var(--agent-worker)';
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden style={{ flex: '0 0 auto', display: 'block', ...style }}>
      <rect x="5" y="4" width="6" height="24" rx="3" fill={gold} />
      <rect x="5" y="4" width="22" height="6" rx="3" fill={gold} />
      <rect x="5" y="13" width="15" height="6" rx="3" fill={violet} opacity={mono ? 0.55 : 1} />
    </svg>
  );
}

/** Mark + wordmark lockup. The word is the product name in the UI face, 600 weight. */
export function Logo({ size = 22, tagline, mono, style }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.4), ...style }}>
      <LogoMark size={size} mono={mono} />
      <span style={{
        fontSize: Math.round(size * 0.82), fontWeight: 'var(--fw-semibold)', letterSpacing: '-0.01em',
        color: mono ? 'currentColor' : 'var(--ink-0)', lineHeight: 1,
      }}>Foreman</span>
      {tagline && <span style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)', marginLeft: 4 }}>{tagline}</span>}
    </span>
  );
}
