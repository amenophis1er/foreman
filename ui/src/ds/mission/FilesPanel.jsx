import React, { useState } from 'react';
import { Icon } from '../core/Icon';
import { Empty } from '../core/Empty';
import { SectionTitle } from '../core/SectionTitle';
import { ArtifactViewer } from './ArtifactViewer';
import { FolderBrowser, commonDir } from './FolderBrowser';

const STATUS_LABEL = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed' };
const STATUS_COLOR = {
  added: 'var(--status-good)', deleted: 'var(--status-critical)',
  modified: 'var(--ink-1)', renamed: 'var(--ink-1)',
};

function artifactUrl(base, path) {
  return `${base}/artifact?path=${encodeURIComponent(path)}`;
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
export function FilesPanel({ runId, deck, loading, error, missing, services = [], urlBase, tree, style }) {
  // Where the files are served from: a run's deck routes, or a project's.
  const base = urlBase ?? `/runs/${encodeURIComponent(runId)}`;
  const [viewingIdx, setViewingIdx] = useState(null);
  const wrap = { display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', ...style };

  if (error) return <div style={wrap}><Empty>Could not read the working tree: {error}</Empty></div>;
  if (missing || (!deck && !loading)) {
    return <div style={wrap}><Empty>No file record for this run — the server has no baseline for it.</Empty></div>;
  }
  if (!deck) return <div style={wrap}><Empty>Reading the working tree…</Empty></div>;

  const { files, artifacts, totals } = deck;
  // The changed files are the viewer's list here; the artifacts have their
  // own browser below, with its own viewer over the folder it is in.
  // The viewer's list here is the changed files; images and the folder have
  // their own viewer inside the browser below.
  const items = files.map((f) => ({ ...f, kind: 'diff' }));
  const fileAt = (i) => setViewingIdx(i);
  const viewing = viewingIdx === null ? null : items[viewingIdx] ?? null;
  // The folder as it stands, with the run's own work files folded in: the
  // tree skips .foreman/work (the scratch area), which is exactly where the
  // artifacts live, so the two lists together are the whole picture.
  const seen = new Set((tree?.files ?? []).map((f) => f.path));
  const folderFiles = [...(tree?.files ?? []), ...artifacts.filter((a) => !seen.has(a.path))];
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

      {services.length > 0 && (
        <section>
          <SectionTitle>Services</SectionTitle>
          {/* Live servers, so a new tab, not the viewer: an app wants a whole
              window and its own origin behaviour, not a sandboxed frame.
              The absolute url from the event, not the path: these are proxied
              on their own port, so a relative link would land on Foreman's. */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {services.map((s) => (
              <a key={s.port} href={s.url ?? s.path} target="_blank" rel="noopener noreferrer"
                title={`${s.label} — 127.0.0.1:${s.port} through Foreman`}
                style={{ ...rowStyle, textDecoration: 'none' }}>
                <Icon name="provider" size={12} color="var(--status-good)" />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink-0)' }}>{s.label}</span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', flex: '0 0 auto' }}>:{s.port}</span>
              </a>
            ))}
          </div>
        </section>
      )}

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
        <SectionTitle>Folder</SectionTitle>
        {tree
          ? <FolderBrowser key={runId} files={folderFiles} truncated={tree.truncated} loading={tree.loading} error={tree.error}
              onRefresh={tree.refresh} urlBase={base}
              summary={<><span style={{ color: 'var(--ink-0)' }}>{folderFiles.length} file{folderFiles.length === 1 ? '' : 's'}</span> as the folder stands · the run's work files included</>} />
          : artifacts.length === 0
            ? <Empty>No screenshots or work files yet.</Empty>
            : <FolderBrowser key={runId} files={artifacts} urlBase={base} initialDir={commonDir(artifacts)} summary={null} />}
      </section>

      {viewing && (
        <ArtifactViewer artifact={viewing}
          url={viewing.kind === 'diff' && !viewing.binary ? undefined : artifactUrl(base, viewing.path)}
          previewUrl={undefined}
          onClose={() => setViewingIdx(null)}
          index={viewingIdx} count={items.length} onStep={setViewingIdx} />
      )}
    </div>
  );
}
