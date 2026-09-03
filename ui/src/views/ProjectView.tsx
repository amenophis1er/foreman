import { useEffect, useState } from 'react';
import {
  api, useRunHistory, useRunView,
  type ProjectSummary, type RunSummary,
} from '../state';
import { Button, BudgetMeter, Empty, SectionTitle, StatusBadge } from '../design/ui';
import { AgentTree } from './AgentTree';
import { Transcript } from './Transcript';
import { RightPanel } from './RightPanel';

/** Full-width mission composer, shown when the project has no active run. */
function Composer({ p, onStarted }: { p: ProjectSummary; onStarted: () => void }) {
  const [mission, setMission] = useState('');
  const [budget, setBudget] = useState(p.defaultBudgetUsd);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setErr('');
    setBusy(true);
    const r = await api.run(p.id, mission.trim(), budget).finally(() => setBusy(false));
    if (!r.ok) setErr((await r.json()).error);
    else onStarted();
  };

  return (
    <div style={{
      maxWidth: 720, margin: 'var(--sp-5) auto', padding: '0 var(--sp-4)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)',
    }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>New mission</h2>
        <div style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' }}>
          {p.folder}
        </div>
      </div>
      <textarea
        value={mission}
        onChange={(e) => setMission(e.target.value)}
        placeholder={'Describe the mission…\n\nSay what "done" looks like, name constraints, and flag any decision the director should ask you about before implementing.'}
        style={{
          width: '100%', minHeight: 180, resize: 'vertical',
          background: 'var(--bg-card)', border: '1px solid var(--line-strong)',
          borderRadius: 'var(--r-md)', padding: 'var(--sp-3)', color: 'var(--ink-0)',
          lineHeight: 1.55,
        }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-1)', fontSize: 'var(--fs-sm)' }}>
          Budget $
          <input type="number" min={1} value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            style={{
              width: 70, background: 'var(--bg-card)', border: '1px solid var(--line-strong)',
              borderRadius: 'var(--r-sm)', padding: '6px 9px', color: 'var(--ink-0)',
            }} />
        </label>
        <Button variant="primary" disabled={busy || !mission.trim()} onClick={start}>
          Start mission
        </Button>
        {err && <span style={{ color: 'var(--status-critical)', fontSize: 'var(--fs-sm)' }}>✕ {err}</span>}
      </div>
    </div>
  );
}

function RunList({ runs, selected, onSelect }: {
  runs: RunSummary[]; selected: string | null; onSelect: (id: string) => void;
}) {
  return (
    <div style={{ marginTop: 'var(--sp-4)' }}>
      <SectionTitle>Runs</SectionTitle>
      {runs.length === 0 && <Empty>No runs yet.</Empty>}
      {runs.map((r) => (
        <div key={r.id} role="button" onClick={() => onSelect(r.id)}
          title={r.mission}
          style={{
            padding: '6px 10px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
            background: selected === r.id ? 'var(--bg-card)' : 'transparent',
            border: selected === r.id ? '1px solid var(--line-strong)' : '1px solid transparent',
            marginBottom: 2,
          }}>
          <div style={{
            fontSize: 'var(--fs-sm)', overflow: 'hidden', whiteSpace: 'nowrap',
            textOverflow: 'ellipsis', color: 'var(--ink-0)',
          }}>{r.mission}</div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', alignItems: 'center' }}>
            <span>{new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span>${r.costUsd.toFixed(2)}</span>
            <StatusBadge status={r.status} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProjectView({ p, onBack, refreshFleet }: {
  p: ProjectSummary; onBack: () => void; refreshFleet: () => void;
}) {
  const history = useRunHistory(p.id);
  const activeRunId = p.activeRun?.id ?? null;
  // Which run is displayed: the active one by default, or a history selection.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(activeRunId);
  useEffect(() => {
    // A newly started mission takes over the view.
    if (activeRunId) setSelectedRunId(activeRunId);
  }, [activeRunId]);

  const viewingLive = selectedRunId !== null && selectedRunId === activeRunId;
  const run = useRunView(selectedRunId, viewingLive);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  const showComposer = !activeRunId && selectedRunId === null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
        padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--line)',
      }}>
        <Button onClick={onBack} title="Back to fleet">← Fleet</Button>
        <div>
          <div style={{ fontWeight: 600 }}>{p.name}</div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
            {p.folder}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          {selectedRunId && <StatusBadge status={run.runStatus} />}
          {selectedRunId && <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} />}
          {viewingLive && run.runStatus === 'running' && (
            <Button variant="danger" onClick={() => void api.interrupt(selectedRunId!)}>Interrupt</Button>
          )}
          {!activeRunId && selectedRunId && (
            <Button variant="primary" onClick={() => setSelectedRunId(null)}>New mission</Button>
          )}
        </div>
      </header>

      {selectedRunId && !viewingLive && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
          padding: 'var(--sp-1) var(--sp-3)', background: 'var(--bg-inset)',
          borderBottom: '1px solid var(--line)', fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
        }}>
          <span aria-hidden style={{ color: 'var(--status-warning)' }}>◷</span>
          Viewing a past run (read-only).
        </div>
      )}

      {showComposer ? (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '250px 1fr' }}>
          <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-panel)', overflowY: 'auto', padding: 'var(--sp-3)' }}>
            <RunList runs={history} selected={null} onSelect={setSelectedRunId} />
          </div>
          <div style={{ overflowY: 'auto' }}>
            <Composer p={p} onStarted={refreshFleet} />
          </div>
        </div>
      ) : (
        <main style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '250px 1fr 340px' }}>
          <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-panel)', minHeight: 0, overflow: 'hidden auto', padding: 'var(--sp-3)' }}>
            <AgentTree s={run} selected={agentFilter} onSelect={setAgentFilter} />
            <RunList runs={history} selected={selectedRunId} onSelect={setSelectedRunId} />
          </div>
          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Transcript s={run} filter={agentFilter} />
          </div>
          <div style={{ borderLeft: '1px solid var(--line)', background: 'var(--bg-panel)', minHeight: 0, overflow: 'hidden auto' }}>
            <RightPanel s={run} />
          </div>
        </main>
      )}
    </div>
  );
}
