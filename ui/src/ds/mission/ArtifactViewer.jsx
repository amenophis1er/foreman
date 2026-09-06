import React, { useEffect, useState } from 'react';
import { Icon } from '../core/Icon';
import { Button } from '../core/Button';
import { IconButton } from '../core/IconButton';
import { RichText } from '../core/RichText';
import { Tabs } from '../core/Tabs';
import { Diff } from './Diff';

const TEXT_CAP = 512 * 1024;

/**
 * An artifact, looked at in place. Images fit the viewport; text and code
 * come as a mono block (Markdown rendered); PDFs use the browser's viewer in
 * a frame; anything else says so and offers the file. Escape and the
 * backdrop close it; "Open in a new tab" is still there for the person who
 * wants the raw file, so nothing is lost — only the detour.
 */
export function ArtifactViewer({ artifact, url, previewUrl, onClose, index, count, onStep }) {
  // HTML has two honest views: what was written, and what it looks like. The
  // render lives in a sandboxed frame on the preview route (opaque origin);
  // the source is the same text view every other file gets.
  const isHtml = /\.html?$/i.test(artifact?.path ?? '');
  const [htmlView, setHtmlView] = useState('rendered');
  const canStep = typeof onStep === 'function' && typeof count === 'number' && count > 1;
  const prev = canStep && index > 0 ? () => onStep(index - 1) : null;
  const next = canStep && index < count - 1 ? () => onStep(index + 1) : null;
  const [text, setText] = useState(null);
  const [err, setErr] = useState(null);
  const kind = artifact?.kind;
  const isDiff = kind === 'diff';
  const name = artifact?.path?.split('/').pop() ?? '';
  const isMd = /\.md$/i.test(name);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && prev) { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight' && next) { e.preventDefault(); next(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next]);

  useEffect(() => {
    setText(null); setErr(null);
    if (kind !== 'text' || !url) return;
    let live = true;
    fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      if (live) setText(t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP)}\n\n[… ${t.length - TEXT_CAP} more characters — open in a new tab for the whole file]` : t);
    }).catch((e) => { if (live) setErr(String(e.message || e)); });
    return () => { live = false; };
  }, [url, kind]);

  if (!artifact) return null;
  const size = typeof artifact.size !== 'number' ? null : artifact.size >= 1024 * 1024 ? `${(artifact.size / 1024 / 1024).toFixed(1)} MB`
    : artifact.size >= 1024 ? `${(artifact.size / 1024).toFixed(1)} KB` : `${artifact.size} B`;

  let body;
  const binaryImage = isDiff && artifact.binary && url && /\.(png|jpe?g|webp|gif|svg)$/i.test(name);
  if (binaryImage) {
    // An added or changed screenshot has no diff worth reading; the file is the change.
    body = <img src={url} alt={artifact.path} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', margin: 'auto', background: 'var(--bg-inset)' }} />;
  } else if (isDiff) {
    body = artifact.binary
      ? <div style={{ margin: 'auto', color: 'var(--ink-2)' }}>Binary file — no diff to show.</div>
      : artifact.diff
        ? <Diff text={artifact.diff} truncated={artifact.truncated} style={{ minHeight: '100%' }} />
        : <div style={{ margin: 'auto', color: 'var(--ink-2)' }}>No diff recorded for this file.</div>;
  } else if (isHtml && previewUrl && htmlView === 'rendered') {
    body = <iframe title={artifact.path} src={previewUrl} sandbox="allow-scripts"
      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />;
  } else if (kind === 'image') {
    body = <img src={url} alt={artifact.path} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', margin: 'auto', background: 'var(--bg-inset)' }} />;
  } else if (kind === 'pdf') {
    body = <iframe title={artifact.path} src={url} style={{ width: '100%', height: '100%', border: 'none', background: 'var(--bg-inset)' }} />;
  } else if (kind === 'text') {
    body = err ? <div style={{ padding: 'var(--sp-3)', color: 'var(--status-critical)' }}>Could not load it: {err}</div>
      : text === null ? <div style={{ padding: 'var(--sp-3)', color: 'var(--ink-2)' }}>Loading…</div>
      : isMd ? <div style={{ padding: 'var(--sp-3) var(--sp-4)', maxWidth: '72ch', margin: '0 auto' }}><RichText text={text} slots={false} /></div>
      : <pre style={{
          margin: 0, padding: 'var(--sp-3) var(--sp-4)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)',
          lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink-0)', tabSize: 2,
        }}>{text}</pre>;
  } else {
    body = (
      <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', alignItems: 'center' }}>
        <Icon name="file" size={28} color="var(--ink-3)" />
        <span>No preview for this kind of file.</span>
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand)' }}>Download {name}</a>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={artifact.path} onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--sp-4)',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 'min(1200px, 100%)', height: 'min(900px, 100%)', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-card)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-md)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.35)', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '6px var(--sp-2) 6px var(--sp-3)',
          borderBottom: '1px solid var(--line)', background: 'var(--bg-panel)', flex: '0 0 auto', minWidth: 0,
        }}>
          <Icon name={kind === 'image' ? 'Image' : kind === 'text' ? 'transcript' : 'file'} size={14} color="var(--ink-2)" />
          {isDiff && artifact.status && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', flex: '0 0 auto' }}>{artifact.status}</span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={artifact.path}>{artifact.path}</span>
          {isDiff ? (
            <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
              <span style={{ color: 'var(--status-good)' }}>+{artifact.additions ?? 0}</span>{' '}
              <span style={{ color: 'var(--status-critical)' }}>−{artifact.deletions ?? 0}</span>
            </span>
          ) : size && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{size}</span>
          )}
          {isHtml && previewUrl && (
            <Tabs size="sm" value={htmlView} onChange={setHtmlView} tabs={[
              { value: 'rendered', label: 'Rendered' },
              { value: 'source', label: 'Source' },
            ]} />
          )}
          {canStep && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: '0 0 auto', marginLeft: 'var(--sp-1)' }}>
              <IconButton icon="chevronLeft" label="Previous (←)" onClick={prev ?? undefined} disabled={!prev} size="sm" />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', minWidth: '4.5ch', textAlign: 'center' }}>{index + 1} / {count}</span>
              <IconButton icon="chevronRight" label="Next (→)" onClick={next ?? undefined} disabled={!next} size="sm" />
            </span>
          )}
          {url && !isDiff && (
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', flex: '0 0 auto' }}>
              <Button variant="ghost" size="sm">Open in a new tab</Button>
            </a>
          )}
          <IconButton icon="close" label="Close (Esc)" onClick={onClose} size="sm" />
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', background: kind === 'image' ? 'var(--bg-inset)' : 'var(--bg-card)' }}>
          {body}
        </div>
      </div>
    </div>
  );
}
