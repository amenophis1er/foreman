import { useState } from 'react';
import { useForeman } from './state';
import { Button } from './design/ui';
import { Header } from './views/Header';
import { AgentTree } from './views/AgentTree';
import { Transcript } from './views/Transcript';
import { RightPanel } from './views/RightPanel';

export default function App() {
  const { state: s, runs, mode, viewRun, backToLive } = useForeman();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Header s={s} />
      {mode.kind === 'history' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
          padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-inset)',
          borderBottom: '1px solid var(--line)', fontSize: 'var(--fs-sm)',
          color: 'var(--ink-1)',
        }}>
          <span aria-hidden style={{ color: 'var(--status-warning)' }}>◷</span>
          Viewing a past run (read-only).
          <Button onClick={backToLive} style={{ marginLeft: 'auto', padding: '3px 10px' }}>
            Back to live
          </Button>
        </div>
      )}
      <main style={{
        flex: 1, minHeight: 0,
        display: 'grid', gridTemplateColumns: '250px 1fr 340px',
      }}>
        <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-panel)', minHeight: 0, overflow: 'hidden auto' }}>
          <AgentTree s={s} selected={selected} onSelect={setSelected}
            runs={runs} mode={mode} onViewRun={viewRun} />
        </div>
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <Transcript s={s} filter={selected} />
        </div>
        <div style={{ borderLeft: '1px solid var(--line)', background: 'var(--bg-panel)', minHeight: 0, overflow: 'hidden auto' }}>
          <RightPanel s={s} />
        </div>
      </main>
    </div>
  );
}
