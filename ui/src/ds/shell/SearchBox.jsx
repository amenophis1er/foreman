import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../core/Icon';
import { StatusBadge } from '../status/StatusBadge';

/**
 * The header's finder. One field on every screen: type, and a dropdown
 * answers with projects, runs from every project's history, and a few
 * actions. Enter opens the first hit, arrows move, Escape clears then blurs.
 * `/` or ⌘K focuses it from anywhere, because this is a control surface
 * people come back to all day.
 *
 * It finds; it does not filter. The fleet page reads the same query to
 * narrow its cards, which is that page's business, not this box's.
 */
export function SearchBox({ value, onChange, groups = [], placeholder = 'Search projects and runs…', busy = false, style }) {
  const input = useRef(null);
  const [focus, setFocus] = useState(false);
  const [cursor, setCursor] = useState(0);
  const has = value.trim().length > 0;
  const flat = groups.flatMap((g) => g.items);
  const open = focus && has && (flat.length > 0 || !busy);

  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const slash = e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
      const cmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey;
      if (slash || cmdK) { e.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { setCursor(0); }, [value, flat.length]);

  const pick = (item) => {
    item.onPick?.();
    onChange?.('');
    input.current?.blur();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (value) onChange?.(''); else e.currentTarget.blur();
      return;
    }
    if (!open || !flat.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % flat.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + flat.length) % flat.length); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(flat[cursor] ?? flat[0]); }
  };

  let index = -1;
  return (
    <div style={{ position: 'relative', flex: '0 1 26rem', minWidth: '12rem', ...style }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
        background: 'var(--bg-card)', borderRadius: 'var(--r-sm)',
        border: `1px solid ${focus ? 'var(--brand)' : 'var(--line)'}`,
        padding: '4px var(--sp-2)', transition: 'border-color var(--dur-fast) var(--ease)',
      }}>
        <Icon name="search" size={14} color="var(--ink-2)" />
        <input ref={input} value={value} type="text" placeholder={placeholder}
          aria-label="Search projects, runs and actions" role="combobox" aria-expanded={open}
          onChange={(e) => onChange?.(e.target.value)}
          onFocus={() => setFocus(true)}
          // Blur after a click on a result has had its chance to fire.
          onBlur={() => setTimeout(() => setFocus(false), 120)}
          onKeyDown={onKeyDown}
          style={{
            flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--ink-0)', font: 'inherit', fontSize: 'var(--fs-sm)', padding: 0, boxShadow: 'none',
          }} />
        {has ? (
          <button type="button" onClick={() => { onChange?.(''); input.current?.focus(); }}
            title="Clear (Esc)" aria-label="Clear search"
            style={{ display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--ink-2)' }}>
            <Icon name="close" size={13} />
          </button>
        ) : (
          <kbd style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
            border: '1px solid var(--line)', borderRadius: 3, padding: '0 4px', lineHeight: '15px', whiteSpace: 'nowrap',
          }}>⌘K</kbd>
        )}
      </div>

      {open && (
        <div role="listbox" style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: 'max(100%, 34rem)', maxWidth: 'calc(100vw - 2rem)',
          maxHeight: '60vh', overflowY: 'auto', zIndex: 30,
          background: 'var(--bg-panel)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-md)',
          boxShadow: '0 12px 32px rgba(0,0,0,.35)', padding: 'var(--sp-1) 0',
        }}>
          {flat.length === 0 && (
            <div style={{ padding: 'var(--sp-2) var(--sp-3)', fontSize: 'var(--fs-sm)', color: 'var(--ink-2)' }}>
              Nothing matches “{value.trim()}”.
            </div>
          )}
          {groups.filter((g) => g.items.length).map((g) => (
            <div key={g.label}>
              <div style={{
                padding: '6px var(--sp-3) 2px', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
                letterSpacing: '.06em', textTransform: 'uppercase',
              }}>{g.label}{g.count !== undefined ? ` · ${g.count}` : ''}</div>
              {g.items.map((it) => {
                index += 1;
                const i = index;
                const selected = i === cursor;
                return (
                  <button key={it.id} type="button" role="option" aria-selected={selected}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pick(it)}
                    style={{
                      display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 'var(--sp-2)',
                      width: '100%', textAlign: 'left', padding: '6px var(--sp-3)', border: 'none', font: 'inherit',
                      background: selected ? 'var(--bg-hover)' : 'transparent', color: 'var(--ink-0)', cursor: 'pointer',
                    }}>
                    <Icon name={it.icon ?? 'folder'} size={14} color="var(--ink-2)" />
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-sm)' }}>{it.title}</span>
                      {it.detail && (
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{it.detail}</span>
                      )}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                      {it.status && <StatusBadge status={it.status} />}
                      {it.meta}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
