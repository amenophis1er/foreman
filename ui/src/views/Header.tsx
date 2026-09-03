import { useState } from 'react';
import { api, type State } from '../state';
import { Button, BudgetMeter, StatusBadge } from '../design/ui';

function FolderPicker({ initial, onPick, onClose }: {
  initial: string; onPick: (p: string) => void; onClose: () => void;
}) {
  const [cur, setCur] = useState<{ path: string; parent: string | null; dirs: string[] } | null>(null);

  const load = async (p?: string) => {
    const r = await api.browse(p);
    if (r.ok) setCur(await r.json());
  };
  if (cur === null) void load(initial || undefined);

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

export function Header({ s }: { s: State }) {
  const [folder, setFolder] = useState('');
  const [mission, setMission] = useState('');
  const [budget, setBudget] = useState(5);
  const [picker, setPicker] = useState(false);
  const [err, setErr] = useState('');

  const running = s.runStatus === 'running';

  const start = async () => {
    setErr('');
    const r = await api.run(folder.trim(), mission.trim(), budget);
    if (!r.ok) setErr((await r.json()).error);
  };

  return (
    <header style={{
      display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap',
      padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--line)',
    }}>
      <h1 style={{ margin: '0 8px 0 0', fontSize: 'var(--fs-lg)', color: 'var(--brand)' }}>Foreman</h1>
      <input value={folder} onChange={(e) => setFolder(e.target.value)}
        placeholder="/absolute/path/to/folder" style={{ ...inputStyle, width: 280 }} />
      <Button onClick={() => setPicker(true)} title="Browse folders">📁</Button>
      <textarea value={mission} onChange={(e) => setMission(e.target.value)}
        placeholder="Mission…" style={{ ...inputStyle, width: 360, height: 34, resize: 'vertical' }} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--ink-1)', fontSize: 'var(--fs-sm)' }}>
        $<input type="number" min={1} value={budget}
          onChange={(e) => setBudget(Number(e.target.value))} style={{ ...inputStyle, width: 60 }} />
      </label>
      <Button variant="primary" onClick={start} disabled={running || !folder.trim() || !mission.trim()}>
        Start
      </Button>
      <Button variant="danger" onClick={() => api.interrupt()} disabled={!running}>Interrupt</Button>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        {err && <span style={{ color: 'var(--status-critical)', fontSize: 'var(--fs-sm)' }}>✕ {err}</span>}
        {!s.connected && <span style={{ color: 'var(--status-serious)', fontSize: 'var(--fs-sm)' }}>⏻ disconnected</span>}
        <StatusBadge status={s.runStatus} />
        <BudgetMeter spent={s.costUsd} budget={s.budgetUsd} />
      </div>
      {picker && <FolderPicker initial={folder} onPick={setFolder} onClose={() => setPicker(false)} />}
    </header>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--line-strong)',
  borderRadius: 'var(--r-sm)', padding: '6px 9px', color: 'var(--ink-0)',
};
