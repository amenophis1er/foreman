import { useEffect, useState } from 'react';
import { api } from '../state';
import { Button } from '../design/ui';

type Listing = { path: string; parent: string | null; dirs: string[] };

export function FolderPicker({ initial, onPick, onClose }: {
  initial?: string; onPick: (p: string) => void; onClose: () => void;
}) {
  const [cur, setCur] = useState<Listing | null>(null);

  const load = async (p?: string) => {
    const r = await api.browse(p);
    if (r.ok) setCur(await r.json());
  };
  useEffect(() => { void load(initial || undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-panel)', border: '1px solid var(--line-strong)',
        borderRadius: 'var(--r-md)', overflow: 'hidden',
      }}>
        <div style={{
          padding: 'var(--sp-3)', font: 'var(--fs-sm) var(--font-mono)',
          color: 'var(--brand)', borderBottom: '1px solid var(--line)', wordBreak: 'break-all',
        }}>{cur?.path ?? '…'}</div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {cur?.parent && (
            <div role="button" onClick={() => load(cur.parent!)} style={rowStyle}>⬑ ..</div>
          )}
          {cur?.dirs.map((d) => (
            <div key={d} role="button" style={rowStyle}
              onClick={() => load(`${cur.path}${cur.path.endsWith('/') ? '' : '/'}${d}`)}>
              📁 {d}
            </div>
          ))}
          {cur && cur.dirs.length === 0 && (
            <div style={{ padding: 'var(--sp-3)', color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>
              No subfolders.
            </div>
          )}
        </div>
        <div style={{
          display: 'flex', gap: 'var(--sp-2)', padding: 'var(--sp-3)',
          borderTop: '1px solid var(--line)', justifyContent: 'flex-end',
        }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { if (cur) onPick(cur.path); onClose(); }}>
            Select this folder
          </Button>
        </div>
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  padding: '7px 12px', cursor: 'pointer', fontSize: 'var(--fs-md)',
};
