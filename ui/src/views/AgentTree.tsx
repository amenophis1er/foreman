import type { RunView } from '../state';
import { SectionTitle, StatusBadge, Empty, agentColor } from '../design/ui';

export function AgentTree({ s, selected, onSelect }: {
  s: RunView; selected: string | null; onSelect: (a: string | null) => void;
}) {
  const director = s.agents.find((a) => a.id === 'director');
  const workers = s.agents
    .filter((a) => a.id !== 'director')
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const row = (id: string, indent: boolean, status: RunView['agents'][0]['status'], task?: string) => (
    <div key={id} role="button" onClick={() => onSelect(selected === id ? null : id)}
      title={task}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
        padding: '7px 10px', marginLeft: indent ? 'var(--sp-4)' : 0,
        borderRadius: 'var(--r-sm)', cursor: 'pointer',
        background: selected === id ? 'var(--bg-card)' : 'transparent',
        border: selected === id ? '1px solid var(--line-strong)' : '1px solid transparent',
      }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: agentColor(id) }} />
      <span style={{ flex: 1, fontSize: 'var(--fs-md)' }}>{id}</span>
      <StatusBadge status={status} />
    </div>
  );

  return (
    <div>
      <SectionTitle>Agents</SectionTitle>
      {s.agents.length === 0 && <Empty>No agents yet.</Empty>}
      {director && row('director', false, director.status)}
      {workers.map((w) => row(w.id, true, w.status, w.task))}
      {selected && (
        <div style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
          Filtering to <b style={{ color: 'var(--ink-1)' }}>{selected}</b> — click again to clear.
        </div>
      )}
      {s.directorSessionId && (
        <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
          director session {s.directorSessionId.slice(0, 8)}
        </div>
      )}
    </div>
  );
}
