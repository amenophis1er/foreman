import React, { forwardRef } from 'react';

/**
 * Multi-line input. `size="mission"` is the composer brief; `size="answer"` is the reply box in a question card.
 * `bare` drops border, background and radius so it can sit inside an editor frame (the composer).
 */
export const Textarea = forwardRef(function Textarea({ value, onChange, placeholder, size = 'mission', bare, onKeyDown, onPaste, onFocus, onBlur, style }, ref) {
  const mission = size === 'mission';
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      onBlur={onBlur}
      onChange={(e) => onChange?.(e.target.value)}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        display: 'block',
        minHeight: mission ? 180 : undefined,
        height: mission ? undefined : 56,
        resize: 'vertical',
        background: bare ? 'transparent' : mission ? 'var(--bg-card)' : 'var(--bg-inset)',
        border: bare ? 'none' : '1px solid var(--line-strong)',
        outline: bare ? 'none' : undefined,
        borderRadius: bare ? 0 : mission ? 'var(--r-md)' : 'var(--r-sm)',
        padding: mission ? 'var(--sp-3)' : 'var(--sp-2)',
        color: 'var(--ink-0)',
        lineHeight: mission ? 'var(--lh-prose)' : 'var(--lh)',
        ...style,
      }}
    />
  );
});
