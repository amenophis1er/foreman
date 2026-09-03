import { useEffect, useState } from 'react';
import { api } from '../state';
import { Button } from '../design/ui';

type Listing = { path: string; parent: string | null; dirs: string[] };

export function FolderPicker({ initial, onPick, onClose }: {
  initial?: string; onPick: (p: string) => void; onClose: () => void;
}) {
  const [cur, setCur] = useState<Listing | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [err, setErr] = useState('');

  const load = async (p?: string) => {
    setErr('');
    const r = await api.browse(p);
    if (r.ok) setCur(await r.json());
  };

  const createFolder = async () => {
    if (!cur || !newName.trim()) return;
    setErr('');
    const r = await api.mkdir(cur.path, newName.trim());
    if (!r.ok) {
      setErr((await r.json()).error);
      return;
    }
    const { path } = await r.json();
    setCreating(false);
    setNewName('');
    await load(path); // navigate into the new folder, ready to select
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
        {creating && (
          <div style={{
            display: 'flex', gap: 'var(--sp-2)', padding: 'var(--sp-2) var(--sp-3)',
            borderTop: '1px solid var(--line)', alignItems: 'center',
          }}>
            <input autoFocus value={newName} placeholder="New folder name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createFolder(); }}
              style={{
                flex: 1, background: 'var(--bg-card)', border: '1px solid var(--line-strong)',
                borderRadius: 'var(--r-sm)', padding: '6px 9px', color: 'var(--ink-0)',
              }} />
            <Button variant="good" onClick={() => void createFolder()}>Create</Button>
          </div>
        )}
        {err && (
          <div style={{ padding: '4px var(--sp-3)', color: 'var(--status-critical)', fontSize: 'var(--fs-xs)' }}>
            ✕ {err}
          </div>
        )}
        <div style={{
          display: 'flex', gap: 'var(--sp-2)', padding: 'var(--sp-3)',
          borderTop: '1px solid var(--line)', alignItems: 'center',
        }}>
          <Button onClick={() => setCreating(!creating)} title="Create a subfolder here">＋ New folder</Button>
          <span style={{ flex: 1 }} />
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
