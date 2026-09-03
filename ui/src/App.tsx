import { useState } from 'react';
import { useForeman } from './state';
import { Header } from './views/Header';
import { AgentTree } from './views/AgentTree';
import { Transcript } from './views/Transcript';
import { RightPanel } from './views/RightPanel';

export default function App() {
  const s = useForeman();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Header s={s} />
      <main style={{
        flex: 1, minHeight: 0,
        display: 'grid', gridTemplateColumns: '220px 1fr 340px',
      }}>
        <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-panel)', minHeight: 0, overflow: 'hidden' }}>
          <AgentTree s={s} selected={selected} onSelect={setSelected} />
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
