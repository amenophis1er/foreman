import React, { useState, useRef, useEffect } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';

/**
 * Talking to the planner before a mission exists. Docked under the planning
 * transcript, the same shell as SteerBar without the recipient and timing
 * controls — there is one listener here, and nothing to interrupt.
 */
export function ChatBar({ value, onChange, onSend, busy, disabled, disabledReason, placeholder, who, style }) {
  const [localText, setLocalText] = useState('');
  const [focus, setFocus] = useState(false);
  const ta = useRef(null);

  const text = value ?? localText;
  const setText = onChange ?? setLocalText;
  const canSend = !disabled && !busy && text.trim().length > 0;

  useEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [text]);

  const send = () => {
    if (!canSend) return;
    onSend?.(text.trim());
    setText('');
  };

  return (
    <div style={{
      flex: '0 0 auto',
      background: 'var(--bg-card)', border: `1px solid ${focus ? 'var(--brand)' : 'var(--line-strong)'}`,
      borderRadius: 'var(--r-md)', padding: 'var(--sp-2) var(--sp-3)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      opacity: disabled ? 0.6 : 1,
      transition: 'border-color var(--dur-fast) var(--ease)', ...style,
    }}>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
        {/* The design system moves two things and no more, so a waiting
            planner borrows the existing pulse rather than adding a spinner. */}
        <span className={busy ? 'pulse' : undefined} style={{ marginTop: 3, flex: '0 0 auto', display: 'inline-flex' }}>
          <Icon name={busy ? 'loading' : 'steer'} size={15} color="var(--brand)" />
        </span>
        <textarea ref={ta} rows={1} value={text} disabled={disabled}
          placeholder={disabled
            ? (disabledReason || 'Not available right now.')
            : (placeholder || 'Ask, think out loud, or describe what you want built…')}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}
          style={{
            flex: 1, minWidth: 0, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--ink-0)', font: 'inherit', lineHeight: 'var(--lh)', padding: '2px 0', maxHeight: 160,
          }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        {/* Who is answering, always. A conversation with no visible model or
            provider left the human unable to tell Sonnet on their subscription
            from a local model through a gateway — which decides both the
            quality of the advice and who pays for it. */}
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={who ? `${who.model} via ${who.provider}` : undefined}>
          {who && (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)' }}>
              {who.model} · {who.provider.split(' · ')[0]}
              {who.costBasis === 'free' ? ' · free' : who.costBasis === 'unpriced' ? ' · unpriced' : ''}
              {' — '}
            </span>
          )}
          {busy ? 'The foreman is looking…' : 'Reads the project, never changes it.'}
        </span>
        <Button size="sm" icon="send" onClick={send} disabled={!canSend} title="⌘↵"
          style={{ marginLeft: 'auto' }}>Send</Button>
      </div>
    </div>
  );
}
