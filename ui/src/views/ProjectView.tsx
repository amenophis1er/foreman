import { useEffect, useState } from 'react';
import {
  api, useRunHistory, useRunView,
  type ModelChoice, type ProjectSummary, type RunSummary,
} from '../state';
import { BillingBadge, Button, BudgetMeter, Empty, SectionTitle, StatusBadge, type AuthMode } from '../design/ui';
import { AgentTree } from './AgentTree';
import { Transcript } from './Transcript';
import { RightPanel } from './RightPanel';
import { ProjectSettings } from './ProjectSettings';

/** Full-width mission composer, shown when the project has no active run. */
const MODEL_OPTIONS: { value: ModelChoice; label: string }[] = [
  { value: '', label: 'default' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
];

function ModelSelect({ label, value, onChange, hint }: {
  label: string; value: ModelChoice; onChange: (m: ModelChoice) => void; hint: string;
}) {
  return (
    <label title={hint}
      style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-1)', fontSize: 'var(--fs-sm)' }}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as ModelChoice)}
        style={{
          background: 'var(--bg-card)', border: '1px solid var(--line-strong)',
          borderRadius: 'var(--r-sm)', padding: '6px 9px', color: 'var(--ink-0)',
        }}>
        {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function Composer({ p, auth, onStarted }: {
  p: ProjectSummary; auth: { mode: AuthMode; source: string }; onStarted: () => void;
}) {
  const [mission, setMission] = useState('');
  const [budget, setBudget] = useState(p.defaultBudgetUsd);
  const [directorModel, setDirectorModel] = useState<ModelChoice>('');
  const [workerModel, setWorkerModel] = useState<ModelChoice>('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setErr('');
    setBusy(true);
    const r = await api.run(p.id, mission.trim(), budget, directorModel, workerModel)
      .finally(() => setBusy(false));
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-1)', fontSize: 'var(--fs-sm)' }}>
          Budget $
          <input type="number" min={1} value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            style={{
              width: 70, background: 'var(--bg-card)', border: '1px solid var(--line-strong)',
              borderRadius: 'var(--r-sm)', padding: '6px 9px', color: 'var(--ink-0)',
            }} />
        </label>
        <ModelSelect label="Director" value={directorModel} onChange={setDirectorModel}
          hint="Model for the director (planning, verification). Default inherits your Claude Code default." />
        <ModelSelect label="Workers" value={workerModel} onChange={setWorkerModel}
          hint="Model for workers (implementation). Pick sonnet or haiku to cut cost." />
        <Button variant="primary" disabled={busy || !mission.trim()} onClick={start}>
          Start mission
        </Button>
        {err && <span style={{ color: 'var(--status-critical)', fontSize: 'var(--fs-sm)' }}>✕ {err}</span>}
      </div>

      {/* Who pays and which install, stated at the moment of commitment. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap',
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
        marginTop: 'calc(-1 * var(--sp-2))',
      }}>
        <BillingBadge mode={p.billingMode ?? auth.mode}
          source={p.claudeInstance?.billing === 'own-login'
            ? `${p.claudeInstance.configDir} (this project's own login)`
            : auth.source}
          compact />
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          runs on {p.claudeInstance?.configDir ?? 'the server default instance'}
        </span>
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

export function ProjectView({ p, auth, onBack, refreshFleet }: {
  p: ProjectSummary; auth: { mode: AuthMode; source: string };
  onBack: () => void; refreshFleet: () => void;
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
  const selectedRun = history.find((r) => r.id === selectedRunId);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [headerErr, setHeaderErr] = useState('');

  const doResume = async () => {
    if (!selectedRunId) return;
    setHeaderErr('');
    setResuming(true);
    const r = await api.resume(selectedRunId).finally(() => setResuming(false));
    if (!r.ok) setHeaderErr((await r.json()).error);
    else refreshFleet();
  };

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <span style={{ fontWeight: 600 }}>{p.name}</span>
            <button title="Project settings" onClick={() => setSettingsOpen(true)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--ink-2)', fontSize: 'var(--fs-md)', padding: 0, lineHeight: 1,
            }}>&#9881;</button>
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
            {p.folder}
            {p.claudeInstance?.configDir && <> &middot; via {p.claudeInstance.configDir}</>}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          {headerErr && (
            <span style={{ color: 'var(--status-critical)', fontSize: 'var(--fs-sm)' }}>✕ {headerErr}</span>
          )}
          <BillingBadge mode={p.billingMode ?? auth.mode}
            source={p.claudeInstance?.billing === 'own-login'
              ? `${p.claudeInstance.configDir} (this project's own login)`
              : auth.source}
            compact />
          {selectedRunId && <StatusBadge status={run.runStatus} />}
          {selectedRunId && <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} />}
          {viewingLive && run.runStatus === 'running' && (
            <Button variant="danger" onClick={() => void api.interrupt(selectedRunId!)}>Interrupt</Button>
          )}
          {!activeRunId && selectedRunId
            && (selectedRun?.status === 'interrupted' || selectedRun?.status === 'error')
            && selectedRun?.directorSessionId && (
            <Button variant="good" disabled={resuming}
              title="Restore the director's session and continue this mission"
              onClick={() => void doResume()}>
              {resuming ? '⟳ Resuming…' : '⟳ Resume'}
            </Button>
          )}
          {!activeRunId && selectedRunId && (
            <Button variant="primary" onClick={() => setSelectedRunId(null)}>New mission</Button>
          )}
        </div>
      </header>

      {settingsOpen && (
        <ProjectSettings p={p} onClose={() => setSettingsOpen(false)} onSaved={refreshFleet}
          onUnlink={() => { void api.unlinkProject(p.id).then(() => { refreshFleet(); onBack(); }); }} />
      )}

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
            <Composer p={p} auth={auth} onStarted={refreshFleet} />
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
