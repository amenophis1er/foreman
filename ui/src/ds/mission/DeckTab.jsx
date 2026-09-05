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

function artifactUrl(runId, path) {
  return `/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
}

/** A unified diff, line by line. Only the sign decides the tint; hunk headers step back to `--ink-2`. */
function Diff({ text, truncated }) {
  const lines = String(text || '').split('\n');
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', lineHeight: 'var(--lh)',
      background: 'var(--bg-inset)', borderTop: '1px solid var(--line)', overflowX: 'auto',
    }}>
      {lines.map((l, i) => {
        const head = l.startsWith('@@') || l.startsWith('diff ') || l.startsWith('index ')
          || l.startsWith('--- ') || l.startsWith('+++ ');
        const add = !head && l.startsWith('+');
        const del = !head && l.startsWith('-');
        return (
          <div key={i} style={{
            padding: '0 var(--sp-2)', whiteSpace: 'pre',
            background: add ? 'var(--diff-add-bg)' : del ? 'var(--diff-del-bg)' : 'transparent',
            color: head ? 'var(--ink-2)' : 'var(--ink-0)',
          }}>{l || ' '}</div>
        );
      })}
      {truncated && (
        <div style={{ padding: '2px var(--sp-2)', color: 'var(--ink-2)', fontFamily: 'var(--font-ui)' }}>
          first 400 lines — the rest is in your working tree
        </div>
      )}
    </div>
  );
}

function FileRow({ f }) {
  const [open, setOpen] = useState(false);
  const canOpen = Boolean(f.diff) && !f.binary;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'var(--bg-card)', overflow: 'hidden' }}>
      <div role={canOpen ? 'button' : undefined} onClick={canOpen ? () => setOpen(!open) : undefined}
        title={canOpen ? (open ? 'Hide the diff' : 'Show the diff') : f.binary ? 'Binary file — no diff' : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '6px var(--sp-2)',
          cursor: canOpen ? 'pointer' : 'default', minWidth: 0, fontSize: 'var(--fs-sm)',
        }}>
        <Icon name={canOpen ? (open ? 'chevronDown' : 'chevronRight') : 'file'} size={12} color="var(--ink-2)" />
        <span style={{
          fontFamily: 'var(--font-mono)', color: f.status === 'deleted' ? 'var(--ink-2)' : 'var(--ink-0)',
          textDecoration: f.status === 'deleted' ? 'line-through' : 'none',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1,
        }}>{f.path}</span>
        {f.preexisting && (
          <span title="This file had uncommitted changes before the run started; not all of this diff is the crew's."
            style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', flex: '0 0 auto' }}>also dirty before the run</span>
        )}
        <span style={{
          fontSize: 'var(--fs-xs)', padding: '0 6px', borderRadius: 'var(--r-pill)', lineHeight: '16px',
          border: `1px solid ${STATUS_COLOR[f.status] || 'var(--line-strong)'}`,
          color: STATUS_COLOR[f.status] || 'var(--ink-1)', flex: '0 0 auto',
        }}>{f.binary ? 'binary' : STATUS_LABEL[f.status] || f.status}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', flex: '0 0 auto' }}>
          <span style={{ color: 'var(--status-good)' }}>+{f.additions}</span>{' '}
          <span style={{ color: 'var(--status-critical)' }}>−{f.deletions}</span>
        </span>
      </div>
      {open && <Diff text={f.diff} truncated={f.truncated} />}
    </div>
  );
}

/**
 * What the run changed and what it produced. Read-only throughout: no edit,
 * no delete, no terminal — DESIGN.md §11. Its job is to show what this
 * mission did to the folder, which is the one thing your editor cannot tell
 * you and Foreman can.
 */
export function DeckTab({ runId, deck, loading, error, missing, style }) {
  const now = Date.now();
  // The artifact being looked at, in place. One at a time; null when none.
  const [viewing, setViewing] = useState(null);
  const wrap = { padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', ...style };

  if (error) {
    return <div style={wrap}><Empty>Could not load the deck: {error}</Empty></div>;
  }
  if (missing || (!deck && !loading)) {
    return (
      <div style={wrap}>
        <Empty>No deck for this run — the server has not recorded a baseline for it.</Empty>
      </div>
    );
  }
  if (!deck) return <div style={wrap}><Empty>Reading the working tree…</Empty></div>;

  const { files, artifacts, totals } = deck;
  const images = artifacts.filter((a) => a.kind === 'image');
  const others = artifacts.filter((a) => a.kind !== 'image');
  const summary = [
    `${totals.files} file${totals.files === 1 ? '' : 's'} changed`,
    `+${totals.additions} −${totals.deletions}`,
    `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`,
  ].join(' · ');

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)', flexWrap: 'wrap', fontSize: 'var(--fs-sm)' }}>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--ink-0)' }}>{summary}</span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
          {deck.baseline.kind === 'git' && deck.baseline.head
            ? `against ${String(deck.baseline.head).slice(0, 8)}`
            : deck.baseline.kind === 'snapshot' ? 'against a snapshot taken at run start'
              : 'no baseline'}
        </span>
        {deck.note && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--status-serious)' }}>{deck.note}</span>}
      </div>

      <section>
        <SectionTitle>Changed files</SectionTitle>
        {files.length === 0 && <Empty>Nothing changed in the folder yet.</Empty>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {files.map((f) => <FileRow key={`${f.status}:${f.path}`} f={f} />)}
        </div>
      </section>

      <section>
        <SectionTitle>Artifacts</SectionTitle>
        {artifacts.length === 0 && <Empty>No screenshots or work files produced yet.</Empty>}
        {images.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 'var(--sp-2)', marginBottom: others.length ? 'var(--sp-3)' : 0 }}>
            {images.map((a) => (
              <button key={a.path} type="button" onClick={() => setViewing(a)}
                title={`${a.path} · ${fmtSize(a.size)} · ${fmtAgo(a.mtimeMs, now)}`}
                style={{ display: 'block', padding: 0, width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--bg-inset)', color: 'inherit' }}>
                <img src={artifactUrl(runId, a.path)} alt={a.path} loading="lazy"
                  style={{ display: 'block', width: '100%', aspectRatio: '16 / 10', objectFit: 'cover' }} />
                <div style={{
                  padding: '4px 6px', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--ink-1)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{a.path.split('/').pop()}</div>
              </button>
            ))}
          </div>
        )}
        {others.map((a) => (
          <button key={a.path} type="button" onClick={() => setViewing(a)}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '4px 0', width: '100%',
              fontSize: 'var(--fs-sm)', color: 'inherit', minWidth: 0, background: 'none', border: 'none',
              cursor: 'pointer', font: 'inherit', textAlign: 'left',
            }}>
            <Icon name={a.kind === 'pdf' ? 'file' : a.kind === 'text' ? 'transcript' : 'file'} size={13} color="var(--ink-2)" />
            <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{a.path}</span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
              {fmtSize(a.size)} · {fmtAgo(a.mtimeMs, now)}
            </span>
          </button>
        ))}
      </section>
      {viewing && (
        <ArtifactViewer artifact={viewing} url={artifactUrl(runId, viewing.path)} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
