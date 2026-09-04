import React, { useEffect, useState } from 'react';

/** Layout tier for the project view: `wide` ≥1180 (3 columns) · `medium` ≥900 (2 columns + crew strip) · `narrow` (tabs). */
export function useLayoutTier(el) {
  const compute = (w) => (w >= 1180 ? 'wide' : w >= 900 ? 'medium' : 'narrow');
  const [tier, setTier] = useState(() => compute(typeof window !== 'undefined' ? window.innerWidth : 1280));
  useEffect(() => {
    const target = el?.current;
    if (target && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(([e]) => setTier(compute(e.contentRect.width)));
      ro.observe(target);
      return () => ro.disconnect();
    }
    const on = () => setTier(compute(window.innerWidth));
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [el]);
  return tier;
}

/** Bundle-safe alias (only PascalCase exports reach `window.<Namespace>`). `LayoutTier.use(ref)`. */
export const LayoutTier = { use: useLayoutTier, WIDE: 1180, NARROW: 900 };

/** A scrolling side rail on the panel plane. `side` decides which edge carries the hairline. */
export function Rail({ side = 'left', width, children, style }) {
  return (
    <div style={{
      width,
      background: 'var(--bg-panel)',
      borderRight: side === 'left' ? '1px solid var(--line)' : undefined,
      borderLeft: side === 'right' ? '1px solid var(--line)' : undefined,
      minHeight: 0, overflow: 'hidden auto', padding: 'var(--sp-3)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)',
      ...style,
    }}>{children}</div>
  );
}
