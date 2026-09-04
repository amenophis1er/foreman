import React from 'react';

/** Single-line input: card surface, strong hairline, 6px radius. Mono for paths and ids. `prefix` renders a fixed glyph inside the box (`$`). */
export function TextInput({ value, onChange, placeholder, type = 'text', min, max, step, width, mono, prefix, autoFocus, onKeyDown, style }) {
  const input = (
    <input
      type={type}
      min={min} max={max} step={step}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onChange={(e) => onChange?.(type === 'number' ? Number(e.target.value) : e.target.value)}
      style={{
        width: prefix ? '100%' : (width ?? '100%'),
        background: prefix ? 'transparent' : 'var(--bg-card)',
        border: prefix ? 'none' : '1px solid var(--line-strong)',
        borderRadius: 'var(--r-sm)',
        padding: prefix ? '6px 9px 6px 0' : '6px 9px',
        color: 'var(--ink-0)',
        outline: prefix ? 'none' : undefined,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
        ...(prefix ? null : style),
      }}
    />
  );
  if (!prefix) return input;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', width: width ?? '100%', boxSizing: 'border-box',
      background: 'var(--bg-card)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)', paddingLeft: 9, ...style,
    }}>
      <span style={{ color: 'var(--ink-2)', marginRight: 4, userSelect: 'none' }}>{prefix}</span>
      {input}
    </span>
  );
}
