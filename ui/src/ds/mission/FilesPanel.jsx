import React, { useState } from 'react';
import { Icon } from '../core/Icon';
import { Empty } from '../core/Empty';
import { SectionTitle } from '../core/SectionTitle';
import { ArtifactViewer } from './ArtifactViewer';

const STATUS_LABEL = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed' };
const STATUS_COLOR = {
  added: 'var(--status-good)', deleted: 'var(--status-critical)',
  modified: 'var(--ink-1)', renamed: 'var(--ink-1)',
};

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtAgo(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function previewUrl(runId, path) {
  return `/runs/${encodeURIComponent(runId)}/preview/${path.split('/').map(encodeURIComponent).join('/')}`;
}
function artifactUrl(runId, path) {
  return `/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
}

/** A path that keeps its file name when the rail is narrow: the directory clips, the name never does. */
function PathLabel({ path, muted, strike }) {
  const i = path.lastIndexOf('/');
  const dir = i >= 0 ? path.slice(0, i + 1) : '';
  const name = i >= 0 ? path.slice(i + 1) : path;
  return (
    <span title={path} style={{
      fontFamily: 'var(--font-mono)', display: 'flex', minWidth: 0, flex: 1,
      color: muted ? 'var(--ink-2)' : 'var(--ink-0)', textDecoration: strike ? 'line-through' : 'none',
    }}>
      {dir && <span style={{ color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '0 1 auto' }}>{dir}</span>}
      <span style={{ whiteSpace: 'nowrap', flex: '0 0 auto' }}>{name}</span>
    </span>
  );
}

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '4px 6px', width: '100%',
  fontSize: 'var(--fs-sm)', color: 'inherit', minWidth: 0, background: 'none', border: 'none',
  borderRadius: 'var(--r-sm)', cursor: 'pointer', font: 'inherit', textAlign: 'left',
};

function Row({ onClick, title, children }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...rowStyle, background: hover ? 'var(--bg-hover)' : 'none' }}>
      {children}
    </button>
  );
}

/**
 * The Files tab of the mission rail: what the run changed, and what it left
 * behind. A list at rail width — a path, a status, +/− — and one click on
 * anything opens it in the viewer, where a diff or a screenshot has the room
 * it needs. The rail lists; the viewer shows.
 */
export function FilesPanel({ runId, deck, loading, error, missing, style }) {
  const now = Date.now();
  const [viewingIdx, setViewingIdx] = useState(null);
  const wrap = { display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', ...style };

  if (error) return <div style={wrap}><Empty>Could not read the working tree: {error}</Empty></div>;
  if (missing || (!deck && !loading)) {
    return <div style={wrap}><Empty>No file record for this run — the server has no baseline for it.</Empty></div>;
  }
  if (!deck) return <div style={wrap}><Empty>Reading the working tree…</Empty></div>;

  const { files, artifacts, totals } = deck;
  const images = artifacts.filter((a) => a.kind === 'image');
  const others = artifacts.filter((a) => a.kind !== 'image');
  // One list for the viewer, in reading order: edits, then screenshots, then work files.
  const items = [
    ...files.map((f) => ({ ...f, kind: 'diff' })),
    ...images,
    ...others,
  ];
  // Open by position, not by path: a screenshot is in the list twice — as a
  // binary changed file and as an artifact — and a path lookup found the
  // diff entry first, so clicking a thumbnail showed "no diff".
  const fileAt = (i) => setViewingIdx(i);
  const imageAt = (i) => setViewingIdx(files.length + i);
  const otherAt = (i) => setViewingIdx(files.length + images.length + i);
  const viewing = viewingIdx === null ? null : items[viewingIdx] ?? null;
  const baseline = deck.baseline.kind === 'git' && deck.baseline.head
    ? `against ${String(deck.baseline.head).slice(0, 8)}`
    : deck.baseline.kind === 'snapshot' ? 'against a snapshot at run start' : 'no baseline';

  return (
    <div style={wrap}>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', lineHeight: 'var(--lh)' }}>
        <span style={{ color: 'var(--ink-0)' }}>
          {totals.files} changed · <span style={{ color: 'var(--status-good)' }}>+{totals.additions}</span>{' '}
          <span style={{ color: 'var(--status-critical)' }}>−{totals.deletions}</span> · {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'}
        </span>
        {' '}<span>{baseline}</span>
        {deck.note && <div style={{ color: 'var(--status-serious)' }}>{deck.note}</div>}
      </div>

      <section>
        <SectionTitle>Changed files</SectionTitle>
        {files.length === 0 && <Empty>Nothing changed in the folder yet.</Empty>}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {files.map((f, i) => (
            <Row key={`${f.status}:${f.path}`} onClick={() => fileAt(i)}
              title={f.binary ? `${f.path} — binary, no diff` : f.preexisting ? `${f.path} — also dirty before the run` : `${f.path} — open the diff`}>
              <Icon name="file" size={12} color="var(--ink-2)" />
              <PathLabel path={f.path} muted={f.status === 'deleted'} strike={f.status === 'deleted'} />
              <span style={{
                fontSize: 'var(--fs-xs)', padding: '0 5px', borderRadius: 'var(--r-pill)', lineHeight: '15px',
                border: `1px solid ${STATUS_COLOR[f.status] || 'var(--line-strong)'}`,
                color: STATUS_COLOR[f.status] || 'var(--ink-1)', flex: '0 0 auto',
              }}>{f.binary ? 'binary' : STATUS_LABEL[f.status] || f.status}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', flex: '0 0 auto' }}>
                <span style={{ color: 'var(--status-good)' }}>+{f.additions}</span>{' '}
                <span style={{ color: 'var(--status-critical)' }}>−{f.deletions}</span>
              </span>
            </Row>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Artifacts</SectionTitle>
        {artifacts.length === 0 && <Empty>No screenshots or work files yet.</Empty>}
        {images.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 6, marginBottom: others.length ? 'var(--sp-2)' : 0 }}>
            {images.map((a, i) => (
              <button key={a.path} type="button" onClick={() => imageAt(i)}
                title={`${a.path} · ${fmtSize(a.size)} · ${fmtAgo(a.mtimeMs, now)}`}
                style={{ display: 'block', padding: 0, width: '100%', cursor: 'pointer', font: 'inherit', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--bg-inset)', color: 'inherit', textAlign: 'left' }}>
                <img src={artifactUrl(runId, a.path)} alt={a.path} loading="lazy"
                  style={{ display: 'block', width: '100%', aspectRatio: '4 / 3', objectFit: 'cover' }} />
                <div style={{ padding: '2px 5px', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.path.split('/').pop()}
                </div>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {others.map((a, i) => (
            <Row key={a.path} onClick={() => otherAt(i)} title={`${a.path} · ${fmtSize(a.size)} · ${fmtAgo(a.mtimeMs, now)}`}>
              <Icon name={a.kind === 'text' ? 'transcript' : 'file'} size={12} color="var(--ink-2)" />
              <PathLabel path={a.path} />
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{fmtSize(a.size)}</span>
            </Row>
          ))}
        </div>
      </section>

      {viewing && (
        <ArtifactViewer artifact={viewing}
          url={viewing.kind === 'diff' && !viewing.binary ? undefined : artifactUrl(runId, viewing.path)}
          previewUrl={viewing.kind === 'diff' ? undefined : previewUrl(runId, viewing.path)}
          onClose={() => setViewingIdx(null)}
          index={viewingIdx} count={items.length} onStep={setViewingIdx} />
      )}
    </div>
  );
}
