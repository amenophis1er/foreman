import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../core/Icon';

/**
 * Narrows the fleet grid. Sits between the header and the first card, quiet
 * enough to ignore when the fleet is small and there when it is not.
 *
 * `/` focuses it from anywhere on the fleet page and Escape clears it, because
 * this is a control surface people come back to all day — reaching for the
 * mouse to find one project among twenty is the thing being fixed.
 */
export function FleetSearch({ value, onChange, count, total, style }) {
  const input = useRef(null);
  const [focus, setFocus] = useState(false);
  const filtering = value.trim().length > 0;

  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
      maxWidth: 'var(--fleet-max)', margin: '0 auto', width: '100%',
      padding: 'var(--sp-4) var(--sp-5) 0', boxSizing: 'border-box', ...style,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flex: '1 1 auto', maxWidth: '22rem',
        background: 'var(--bg-card)', borderRadius: 'var(--r-sm)',
        border: `1px solid ${focus ? 'var(--brand)' : 'var(--line)'}`,
        padding: '5px var(--sp-2)',
        transition: 'border-color var(--dur-fast) var(--ease)',
      }}>
        <Icon name="search" size={14} color="var(--ink-2)" />
        <input ref={input} value={value} type="text"
          placeholder="Filter projects…"
          aria-label="Filter projects by name, path or mission"
          onChange={(e) => onChange?.(e.target.value)}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            if (value) onChange?.('');
            else e.currentTarget.blur();
          }}
          style={{
            flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--ink-0)', font: 'inherit', fontSize: 'var(--fs-sm)', padding: 0,
            // The wrapper already turns brand on focus; the base stylesheet's
            // focus ring on top of it reads as a second, misaligned box.
            boxShadow: 'none',
          }} />
        {filtering ? (
          <button type="button" onClick={() => { onChange?.(''); input.current?.focus(); }}
            title="Clear filter (Esc)" aria-label="Clear filter"
            style={{
              display: 'inline-flex', background: 'none', border: 'none', padding: 0,
              cursor: 'pointer', color: 'var(--ink-2)',
            }}><Icon name="close" size={13} /></button>
        ) : (
          // The hint occupies the clear button's place, so nothing shifts when
          // the first character is typed.
          <kbd style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
            border: '1px solid var(--line)', borderRadius: 3, padding: '0 4px', lineHeight: '15px',
          }}>/</kbd>
        )}
      </div>
      {filtering && (
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>
          {count} of {total}
        </span>
      )}
    </div>
  );
}
