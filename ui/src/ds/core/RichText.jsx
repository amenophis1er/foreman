import React from 'react';

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|<[^<>\n]{1,80}>)/g;

/** Inline spans: `code`, **bold**, <slot>. Slots are the composer template fill-ins. */
function inline(text, slots) {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92em', background: 'var(--bg-inset)', border: '1px solid var(--line)', borderRadius: 4, padding: '0 5px' }}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i} style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--ink-0)' }}>{part.slice(2, -2)}</strong>;
    if (slots && part.startsWith('<') && part.endsWith('>')) {
      return <span key={i} style={{ background: 'var(--brand-wash-strong)', border: '1px dashed var(--brand)', borderRadius: 4, padding: '0 5px', color: 'var(--ink-0)' }}>{part.slice(1, -1)}</span>;
    }
    return part;
  });
}

/** Line-based block parser: ``` fences, > quotes, - lists, ## headings, paragraphs. No HTML passthrough. */
function parse(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim(); const body = [];
      i++; while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++; blocks.push({ t: 'code', lang, body: body.join('\n') }); continue;
    }
    if (/^>\s?/.test(l)) {
      const body = []; while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', body }); continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      blocks.push({ t: 'list', items }); continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) { blocks.push({ t: 'h', level: h[1].length, body: h[2] }); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const body = []; while (i < lines.length && lines[i].trim() && !/^(```|>|\s*[-*]\s|#{1,3}\s)/.test(lines[i])) body.push(lines[i++]);
    blocks.push({ t: 'p', body });
  }
  return blocks;
}

/**
 * Renders a brief (or any operator/agent prose) with a deliberately small markup set:
 * ``` fenced blocks, `inline code`, > quotes, - lists, ## headings, **bold**, and <angle-bracket> template slots.
 */
export function RichText({ text, slots = true, style }) {
  const blocks = parse(text);
  return (
    // Prose ink for the body; headings, bold and slots keep --ink-0 so the
    // emphasis reads against the paragraph rather than blending into it.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, lineHeight: 'var(--lh-prose)', color: 'var(--ink-prose, var(--ink-0))', ...style }}>
      {blocks.map((b, k) => {
        if (b.t === 'code') return (
          <pre key={k} style={{ margin: 0, padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-inset)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', lineHeight: 'var(--lh)', overflowX: 'auto', whiteSpace: 'pre', position: 'relative' }}>
            {b.lang && <span style={{ position: 'absolute', top: 4, right: 8, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{b.lang}</span>}{b.body}
          </pre>
        );
        if (b.t === 'quote') return (
          <blockquote key={k} style={{ margin: 0, padding: '2px 0 2px 12px', borderLeft: '2px solid var(--agent-worker)', color: 'var(--ink-1)' }}>
            {b.body.map((ln, j) => <div key={j}>{inline(ln, slots)}</div>)}
          </blockquote>
        );
        if (b.t === 'list') return (
          <ul key={k} style={{ margin: 0, paddingLeft: 20 }}>{b.items.map((it, j) => <li key={j}>{inline(it, slots)}</li>)}</ul>
        );
        if (b.t === 'h') return (
          <div key={k} style={{ fontWeight: 'var(--fw-semibold)', fontSize: b.level === 1 ? 'var(--fs-lg)' : 'var(--fs-md)', color: 'var(--ink-0)', marginTop: k ? 4 : 0 }}>{inline(b.body, slots)}</div>
        );
        return <p key={k} style={{ margin: 0 }}>{b.body.map((ln, j) => <React.Fragment key={j}>{j > 0 && <br />}{inline(ln, slots)}</React.Fragment>)}</p>;
      })}
    </div>
  );
}
