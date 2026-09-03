import type { RunSummary, State, ViewMode } from '../state';
import { SectionTitle, StatusBadge, Empty, agentColor } from '../design/ui';

function RunHistory({ runs, mode, onView }: {
  runs: RunSummary[]; mode: ViewMode; onView: (id: string) => void;
}) {
  return (
    <div style={{ marginTop: 'var(--sp-4)' }}>
      <SectionTitle>Runs</SectionTitle>
      {runs.length === 0 && <Empty>No runs recorded.</Empty>}
      {runs.map((r) => {
        const viewing = mode.kind === 'history' && mode.runId === r.id;
        return (
          <div key={r.id} role="button" onClick={() => onView(r.id)}
            title={r.mission}
            style={{
              padding: '6px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
              background: viewing ? 'var(--bg-card)' : 'transparent',
              border: viewing ? '1px solid var(--line-strong)' : '1px solid transparent',
              marginBottom: 2,
            }}>
            <div style={{
              fontSize: 'var(--fs-sm)', overflow: 'hidden', whiteSpace: 'nowrap',
              textOverflow: 'ellipsis', color: 'var(--ink-0)',
            }}>{r.mission}</div>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
              <span>{new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span>${r.costUsd.toFixed(2)}</span>
              <StatusBadge status={r.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AgentTree({ s, selected, onSelect, runs, mode, onViewRun }: {
  s: State; selected: string | null; onSelect: (a: string | null) => void;
  runs: RunSummary[]; mode: ViewMode; onViewRun: (id: string) => void;
}) {
  const director = s.agents.find((a) => a.id === 'director');
  const workers = s.agents
    .filter((a) => a.id !== 'director')
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const row = (id: string, label: string, indent: boolean, status: State['agents'][0]['status'], task?: string) => (
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
      <span style={{ flex: 1, fontSize: 'var(--fs-md)' }}>{label}</span>
      <StatusBadge status={status} />
    </div>
  );

  return (
    <div style={{ padding: 'var(--sp-3)', overflowY: 'auto' }}>
      <SectionTitle>Agents</SectionTitle>
      {s.agents.length === 0 && <Empty>No run yet.</Empty>}
      {director && row('director', 'director', false, director.status)}
      {workers.map((w) => row(w.id, w.id, true, w.status, w.task))}
      {selected && (
        <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
          Filtering transcript to <b style={{ color: 'var(--ink-1)' }}>{selected}</b> — click again to clear.
        </div>
      )}
      {s.directorSessionId && (
        <div style={{ marginTop: 'var(--sp-4)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
          director session {s.directorSessionId.slice(0, 8)}
        </div>
      )}
      <RunHistory runs={runs} mode={mode} onView={onViewRun} />
    </div>
  );
}
