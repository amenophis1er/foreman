import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

const INLINE = /(`[^`\n]+`|<[^<>\n]{1,80}>)/g;

/** Classifies each line so the overlay can colour it. Only line-level state is the ``` fence. */
function classify(value) {
  const out = []; let fence = false;
  for (const text of value.split('\n')) {
    if (/^```/.test(text)) { out.push({ text, kind: 'fence', open: !fence }); fence = !fence; continue; }
    if (fence) { out.push({ text, kind: 'code' }); continue; }
    if (/^>\s?/.test(text)) out.push({ text, kind: 'quote' });
    else if (/^\s*[-*]\s+/.test(text)) out.push({ text, kind: 'list' });
    else if (/^#{1,3}\s/.test(text)) out.push({ text, kind: 'heading' });
    else out.push({ text, kind: 'text' });
  }
  return out;
}

/** Inline spans. Nothing here may change glyph advance — colour, background and box-shadow only, never padding/border/weight. */
function inline(text) {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <span key={i} style={{ background: 'var(--bg-inset)', boxShadow: '0 0 0 1px var(--line)', borderRadius: 3, color: 'var(--agent-worker)' }}>
          <span style={{ color: 'var(--ink-2)' }}>`</span>{part.slice(1, -1)}<span style={{ color: 'var(--ink-2)' }}>`</span>
        </span>
      );
    }
    if (part.startsWith('<') && part.endsWith('>')) {
      return <span key={i} style={{ background: 'var(--brand-wash-strong)', boxShadow: '0 0 0 1px var(--brand)', borderRadius: 3 }}>{part}</span>;
    }
    return part;
  });
}

const PAD = 'var(--sp-3)';

/**
 * Plain textarea with a live syntax overlay (Notion-style inline rendering). The textarea keeps the caret, selection,
 * undo and IME; the overlay paints `code`, ``` blocks, > quotes, - lists, headings and <slots> beneath transparent text.
 * The two layers share font, padding, wrapping and line-height, so every glyph lands on the same pixel.
 */
export const RichEditor = forwardRef(function RichEditor({ value, onChange, placeholder, minHeight = 200, maxHeight = 460, onKeyDown, onPaste, onFocus, onBlur, style }, ref) {
  const ta = useRef(null);
  const pendingCaret = useRef(null);
  useImperativeHandle(ref, () => ta.current);
  useEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = '0px'; el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
    if (pendingCaret.current != null) { el.setSelectionRange(pendingCaret.current, pendingCaret.current); pendingCaret.current = null; }
  }, [value, minHeight]);

  /** Typing ``` at a line start auto-closes the block (caret lands inside); typing the closing ``` always leaves a line below to step out onto. */
  const handleChange = (e) => {
    const el = e.target; let v = el.value; let caret = el.selectionStart;
    const typedTick = e.nativeEvent?.inputType === 'insertText' && e.nativeEvent?.data === '`';
    const before = v.slice(0, caret), after = v.slice(caret);
    const lineStart = before.lastIndexOf('\n') + 1;
    if (typedTick && before.slice(lineStart) === '```' && (after === '' || after.startsWith('\n'))) {
      const opening = ((before.match(/^```/gm) || []).length % 2) === 1;
      if (opening && ((after.match(/^```/gm) || []).length % 2) === 0) { v = `${before}\n\n\`\`\`\n${after.replace(/^\n/, '')}`; caret += 1; }
      else if (!opening) { v = after.startsWith('\n') ? v : `${before}\n${after}`; caret += 1; }
      pendingCaret.current = caret;
    }
    onChange?.(v);
  };

  const lines = classify(value || '');
  const shared = {
    margin: 0, padding: PAD, boxSizing: 'border-box', width: '100%', font: 'inherit', fontSize: 'inherit', lineHeight: 'var(--lh-prose)',
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'break-word', tabSize: 4,
  };

  return (
    <div style={{ position: 'relative', overflowY: 'auto', maxHeight, ...style }}>
      <div aria-hidden style={{ ...shared, position: 'absolute', inset: 0, height: 'auto', color: 'var(--ink-0)', pointerEvents: 'none' }}>
        {!value && placeholder && <div style={{ color: 'var(--ink-2)' }}>{placeholder}</div>}
        {value && lines.map((l, i) => {
          const band = l.kind === 'code' || l.kind === 'fence';
          return (
            <div key={i} style={{
              ...(band ? { background: 'var(--bg-inset)', margin: `0 calc(-0.5 * ${PAD})`, padding: `0 calc(0.5 * ${PAD})` } : null),
              ...(l.kind === 'fence' ? { borderRadius: l.open ? '6px 6px 0 0' : '0 0 6px 6px' } : null),
              ...(l.kind === 'quote' ? { color: 'var(--ink-1)', boxShadow: 'inset 2px 0 0 var(--agent-worker)', margin: `0 calc(-1 * ${PAD})`, padding: `0 ${PAD}` } : null),
              ...(l.kind === 'fence' ? { color: 'var(--ink-2)' } : null),
              ...(l.kind === 'code' ? { color: 'var(--ink-1)' } : null),
            }}>
              {l.text === '' ? '\u200b'
                : l.kind === 'fence' ? <><span style={{ color: 'transparent' }}>```</span>{l.text.slice(3)}</>
                : l.kind === 'code' ? l.text
                : l.kind === 'list' ? <><span style={{ color: 'var(--brand)' }}>{/^\s*[-*]\s+/.exec(l.text)[0]}</span>{inline(l.text.replace(/^\s*[-*]\s+/, ''))}</>
                : l.kind === 'heading' ? <><span style={{ color: 'var(--brand)' }}>{/^#{1,3}\s/.exec(l.text)[0]}</span>{inline(l.text.replace(/^#{1,3}\s/, ''))}</>
                : l.kind === 'quote' ? <><span style={{ color: 'var(--ink-2)' }}>{/^>\s?/.exec(l.text)[0]}</span>{inline(l.text.replace(/^>\s?/, ''))}</>
                : inline(l.text)}
            </div>
          );
        })}
      </div>
      <textarea ref={ta} value={value} onChange={handleChange} spellCheck={false}
        onKeyDown={onKeyDown} onPaste={onPaste} onFocus={onFocus} onBlur={onBlur}
        style={{
          ...shared, position: 'relative', display: 'block', minHeight, resize: 'none', overflow: 'hidden',
          background: 'transparent', border: 'none', outline: 'none', color: 'transparent', caretColor: 'var(--ink-0)',
        }} />
    </div>
  );
});
