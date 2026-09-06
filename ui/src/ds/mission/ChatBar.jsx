import React, { useState, useRef, useEffect } from 'react';
import { AttachmentChip } from '../forms/AttachmentChip';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';

/**
 * Talking to the planner before a mission exists. Docked under the planning
 * transcript, the same shell as SteerBar without the recipient and timing
 * controls — there is one listener here, and nothing to interrupt.
 */
const fileKey = (f) => `${f.name}:${f.size}`;
const LINE_PX = 22;
const MIN_ROWS_PX = LINE_PX * 3;
const MAX_ROWS_PX = LINE_PX * 10;

export function ChatBar({ value, onChange, onSend, onStop, busy, disabled, disabledReason, placeholder, who, onChangeModel, autoFocus, style }) {
  const [localText, setLocalText] = useState('');
  const [focus, setFocus] = useState(false);
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const ta = useRef(null);
  const picker = useRef(null);
  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    setFiles((cur) => { const seen = new Set(cur.map(fileKey)); return [...cur, ...incoming.filter((f) => !seen.has(fileKey(f)))]; });
  };

  const text = value ?? localText;
  const setText = onChange ?? setLocalText;
  const canSend = !disabled && !busy && (text.trim().length > 0 || files.length > 0);

  useEffect(() => {
    const el = ta.current; if (!el) return;
    // Three lines at rest, growing to ten: a one-line slot said "type a
    // command"; a mission brief wants room to be a paragraph.
    el.style.height = 'auto';
    el.style.height = Math.max(MIN_ROWS_PX, Math.min(el.scrollHeight, MAX_ROWS_PX)) + 'px';
  }, [text]);

  const send = () => {
    if (!canSend) return;
    onSend?.(text.trim() || (files.length ? 'See the attached files.' : ''), files);
    setText('');
    setFiles([]);
  };

  return (
    <div style={{
      flex: '0 0 auto',
      background: dragging ? 'var(--brand-wash)' : 'var(--bg-card)', border: `1px solid ${focus || dragging ? 'var(--brand)' : 'var(--line-strong)'}`,
      borderRadius: 'var(--r-md)', padding: 'var(--sp-2) var(--sp-3)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      opacity: disabled ? 0.6 : 1,
      transition: 'border-color var(--dur-fast) var(--ease)', ...style,
    }}
      onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) addFiles(e.dataTransfer.files); }}>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
        {/* The design system moves two things and no more, so a waiting
            planner borrows the existing pulse rather than adding a spinner. */}
        <span className={busy ? 'pulse' : undefined} style={{ marginTop: 3, flex: '0 0 auto', display: 'inline-flex' }}>
          <Icon name={busy ? 'loading' : 'steer'} size={15} color="var(--brand)" />
        </span>
        <textarea ref={ta} rows={3} value={text} disabled={disabled} autoFocus={autoFocus}
          placeholder={disabled
            ? (disabledReason || 'Not available right now.')
            : (placeholder || 'Ask, think out loud, or describe what you want built…')}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}
          style={{
            flex: 1, minWidth: 0, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--ink-0)', font: 'inherit', lineHeight: `${LINE_PX}px`, padding: '2px 0', minHeight: MIN_ROWS_PX, maxHeight: MAX_ROWS_PX,
          }} />
      </div>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {files.map((f, i) => <AttachmentChip key={fileKey(f)} name={f.name} size={f.size} onRemove={() => setFiles((cur) => cur.filter((_, j) => j !== i))} />)}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        {/* Who is answering, always. A conversation with no visible model or
            provider left the human unable to tell Sonnet on their subscription
            from a local model through a gateway — which decides both the
            quality of the advice and who pays for it. */}
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={who ? `${who.model} via ${who.provider}` : undefined}>
          {who && (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)' }}
              role={onChangeModel ? 'button' : undefined}
              onClick={onChangeModel}
              title={onChangeModel ? 'Change the planner model in Settings → Models' : undefined}
              // The one place the planner's model is named is also the way to change it.
              {...(onChangeModel ? { style: { fontFamily: 'var(--font-mono)', color: 'var(--ink-1)', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 } } : {})}>
              {who.model} · {who.provider.split(' · ')[0]}
              {who.costBasis === 'free' ? ' · free' : who.costBasis === 'unpriced' ? ' · unpriced' : ''}
              {' — '}
            </span>
          )}
          {busy ? 'The foreman is looking…' : 'Reads the project, never changes it.'}
        </span>
        <input ref={picker} type="file" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <Button size="sm" variant="ghost" icon="attach" disabled={disabled}
          title="Attach files — or drop them here, or paste an image"
          onClick={() => picker.current?.click()} style={{ marginLeft: 'auto' }}>Attach</Button>
        {busy && onStop
          ? <Button size="sm" variant="danger" icon="close" onClick={onStop} title="Stop the planner and discard the rest of this reply">Stop</Button>
          : <Button size="sm" icon="send" onClick={send} disabled={!canSend} title="⌘↵">Send</Button>}
      </div>
    </div>
  );
}
