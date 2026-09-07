import React, { useMemo, useState } from 'react';
import { Icon } from '../core/Icon';
import { Empty } from '../core/Empty';
import { ArtifactViewer } from './ArtifactViewer';

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function previewUrl(base, path) {
  return `${base}/preview/${path.split('/').map(encodeURIComponent).join('/')}`;
}
function artifactUrl(base, path) {
  return `${base}/artifact?path=${encodeURIComponent(path)}`;
}
const ICON_FOR = { image: 'image', text: 'transcript', pdf: 'file', other: 'file' };

/**
 * One level of a flat file list, as a directory listing.
 *
 * The server hands over every path under the folder (capped) in one flat
 * list; this reads it as a tree without a second request per click. Folders
 * come first, then files, both alphabetical, the way a person expects a
 * folder to read. A folder that holds nothing but one folder is shown as
 * `a/b/c` in a single row — the GitHub compaction — so a deep source tree
 * does not cost one click per empty level.
 */
function listing(files, dir) {
  const prefix = dir ? `${dir}/` : '';
  const folders = new Map();
  const here = [];
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) { here.push(f); continue; }
    const name = rest.slice(0, slash);
    const g = folders.get(name) ?? { name, count: 0, sub: new Set() };
    g.count += 1;
    // What sits directly under the folder: needed to know whether it can be compacted.
    const deeper = rest.slice(slash + 1);
    const nextSlash = deeper.indexOf('/');
    g.sub.add(nextSlash < 0 ? '' : deeper.slice(0, nextSlash));
    folders.set(name, g);
  }
  const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const dirs = [...folders.values()].sort((a, b) => cmp(a.name, b.name)).map((g) => {
    // Compact single-folder chains: a/b/c when a holds only b and b holds only c.
    let label = g.name;
    let full = `${prefix}${g.name}`;
    let cur = g;
    while (cur.sub.size === 1 && !cur.sub.has('')) {
      const [only] = [...cur.sub];
      const next = listing(files, full).dirs.find((d) => d.name === only);
      if (!next) break;
      label = `${label}/${only}`;
      full = `${full}/${only}`;
      cur = { sub: next.sub };
    }
    return { name: g.name, label, path: full, count: g.count, sub: g.sub };
  });
  here.sort((a, b) => cmp(a.path, b.path));
  return { dirs, files: here };
}

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '5px 6px', width: '100%',
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

const nameStyle = { fontFamily: 'var(--font-mono)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink-0)' };
const metaStyle = { fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' };

/** The deepest directory every path shares — where a browser over a run's artifacts should open. */
export function commonDir(files) {
  if (!files?.length) return '';
  let parts = files[0].path.split('/').slice(0, -1);
  for (const f of files) {
    const p = f.path.split('/').slice(0, -1);
    let i = 0;
    while (i < parts.length && i < p.length && parts[i] === p[i]) i++;
    parts = parts.slice(0, i);
    if (!parts.length) break;
  }
  return parts.join('/');
}

/**
 * The project's folder in the rail: one directory at a time, a path bar to
 * climb back up, and one click on a file opens it in the viewer.
 *
 * The earlier panel listed every file in the folder as one flat scroll with
 * a thumbnail grid on top, which for a real repository ran to hundreds of
 * rows before the rail's other content. A folder is browsed, not read; this
 * shows what a directory holds and nothing more.
 */
export function FolderBrowser({ files, truncated, loading, error, onRefresh, urlBase, initialDir = '', summary, style }) {
  const [dir, setDir] = useState(initialDir);
  const [viewingIdx, setViewingIdx] = useState(null);
  const view = useMemo(() => listing(files ?? [], dir), [files, dir]);
  const wrap = { display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', ...style };

  if (error) return <div style={wrap}><Empty>Could not list the folder: {error}</Empty></div>;
  if (loading && !files?.length) return <div style={wrap}><Empty>Reading the folder…</Empty></div>;

  const crumbs = dir ? dir.split('/') : [];
  const viewing = viewingIdx === null ? null : view.files[viewingIdx] ?? null;
  const total = files?.length ?? 0;

  return (
    <div style={wrap}>
      {summary !== null && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', lineHeight: 'var(--lh)' }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          {summary ?? <><span style={{ color: 'var(--ink-0)' }}>{total} file{total === 1 ? '' : 's'}</span> in the folder as it stands · every run here shares them</>}
        </span>
        {onRefresh && (
          <button type="button" onClick={onRefresh} title="Read the folder again" disabled={loading}
            style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--ink-2)', display: 'inline-flex' }}>
            <Icon name={loading ? 'loading' : 'resume'} size={13} />
          </button>
        )}
      </div>
      )}
      {truncated && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--status-serious)' }}>A large folder: only the first 2000 files are listed.</div>}

      {/* The path bar: where you are, and every level above it is a click. */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, padding: '4px 6px',
        border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'var(--bg-inset)',
        fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', minWidth: 0,
      }}>
        <button type="button" onClick={() => setDir('')} title="The project folder"
          style={{ background: 'none', border: 'none', padding: '1px 3px', cursor: dir ? 'pointer' : 'default', color: dir ? 'var(--ink-2)' : 'var(--ink-0)', display: 'inline-flex', alignItems: 'center', gap: 4, font: 'inherit' }}>
          <Icon name="folder" size={12} />{!dir && <span>/</span>}
        </button>
        {crumbs.map((seg, i) => {
          const last = i === crumbs.length - 1;
          const target = crumbs.slice(0, i + 1).join('/');
          return (
            <React.Fragment key={target}>
              <span style={{ color: 'var(--ink-2)' }}>/</span>
              <button type="button" onClick={() => setDir(target)} disabled={last}
                style={{ background: 'none', border: 'none', padding: '1px 3px', cursor: last ? 'default' : 'pointer', color: last ? 'var(--ink-0)' : 'var(--ink-2)', font: 'inherit', fontWeight: last ? 'var(--fw-semibold)' : 'inherit' }}>
                {seg}
              </button>
            </React.Fragment>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {dir && (
          <Row onClick={() => setDir(crumbs.slice(0, -1).join('/'))} title="Up one level">
            <Icon name="parent" size={13} color="var(--ink-2)" />
            <span style={{ ...nameStyle, color: 'var(--ink-2)' }}>..</span>
          </Row>
        )}
        {view.dirs.map((d) => (
          <Row key={d.path} onClick={() => setDir(d.path)} title={`${d.path}/ · ${d.count} file${d.count === 1 ? '' : 's'}`}>
            <Icon name="folder" size={13} color="var(--brand)" />
            <span style={nameStyle}>{d.label}</span>
            <span style={metaStyle}>{d.count}</span>
            <Icon name="chevronRight" size={12} color="var(--ink-2)" />
          </Row>
        ))}
        {view.files.map((f, i) => (
          <Row key={f.path} onClick={() => setViewingIdx(i)} title={`${f.path} · ${fmtSize(f.size)}`}>
            <Icon name={ICON_FOR[f.kind] || 'file'} size={13} color="var(--ink-2)" />
            <span style={nameStyle}>{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
            <span style={metaStyle}>{fmtSize(f.size)}</span>
          </Row>
        ))}
        {view.dirs.length === 0 && view.files.length === 0 && <Empty>{dir ? 'Nothing here.' : 'The folder is empty.'}</Empty>}
      </div>

      {viewing && (
        <ArtifactViewer artifact={viewing}
          url={artifactUrl(urlBase, viewing.path)}
          previewUrl={previewUrl(urlBase, viewing.path)}
          onClose={() => setViewingIdx(null)}
          index={viewingIdx} count={view.files.length} onStep={setViewingIdx} />
      )}
    </div>
  );
}
