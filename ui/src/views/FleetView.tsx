import { useState } from 'react';
import { api, type ProjectSummary } from '../state';
import { BudgetMeter, Empty, StatusBadge, type Status } from '../design/ui';
import { FolderPicker } from './FolderPicker';

function ProjectCard({ p, onOpen, onUnlink }: {
  p: ProjectSummary; onOpen: () => void; onUnlink: () => void;
}) {
  const run = p.activeRun;
  const needsYou = p.pendingPermissions + p.pendingQuestions;
  const status: Status = run ? 'running' : 'idle';

  return (
    <div role="button" onClick={onOpen} style={{
      background: 'var(--bg-card)', borderRadius: 'var(--r-md)', cursor: 'pointer',
      border: needsYou ? '1px solid var(--status-warning)' : '1px solid var(--line)',
      padding: 'var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      minHeight: 130,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>{p.name}</span>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={status} /></span>
      </div>
      <div style={{
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{p.folder}</div>

      {needsYou > 0 && (
        <div className="pulse" style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-1)',
          color: 'var(--status-warning)', fontSize: 'var(--fs-sm)', fontWeight: 600,
        }}>
          🔔 needs you — {p.pendingPermissions > 0 && `${p.pendingPermissions} approval${p.pendingPermissions > 1 ? 's' : ''}`}
          {p.pendingPermissions > 0 && p.pendingQuestions > 0 && ', '}
          {p.pendingQuestions > 0 && `${p.pendingQuestions} question${p.pendingQuestions > 1 ? 's' : ''}`}
        </div>
      )}

      {run ? (
        <>
          <div style={{
            fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{run.mission}</div>
          <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} />
        </>
      ) : (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-2)', marginTop: 'auto' }}>
          No active mission — open to compose one.
        </div>
      )}

      <button onClick={(e) => { e.stopPropagation(); onUnlink(); }}
        title="Unlink project (run history is kept)"
        style={{
          alignSelf: 'flex-end', background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-2)', fontSize: 'var(--fs-xs)', padding: 0,
        }}>unlink</button>
    </div>
  );
}

export function FleetView({ projects, connected, onOpen, refresh }: {
  projects: ProjectSummary[]; connected: boolean;
  onOpen: (projectId: string) => void; refresh: () => void;
}) {
  const [picker, setPicker] = useState(false);

  const link = async (folder: string) => {
    const r = await api.linkProject(folder);
    if (r.ok) {
      refresh();
      onOpen((await r.json()).project.id);
    }
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
        padding: 'var(--sp-3) var(--sp-5)', borderBottom: '1px solid var(--line)',
        background: 'var(--bg-panel)',
      }}>
        <h1 style={{ margin: 0, fontSize: 18, color: 'var(--brand)' }}>Foreman</h1>
        <span style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>mission control</span>
        {!connected && (
          <span style={{ marginLeft: 'auto', color: 'var(--status-serious)', fontSize: 'var(--fs-sm)' }}>
            ⏻ disconnected
          </span>
        )}
      </header>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 'var(--sp-4)', padding: 'var(--sp-5)', maxWidth: 1200, margin: '0 auto',
      }}>
        {projects.map((p) => (
          <ProjectCard key={p.id} p={p}
            onOpen={() => onOpen(p.id)}
            onUnlink={() => { void api.unlinkProject(p.id).then(refresh); }} />
        ))}
        <div role="button" onClick={() => setPicker(true)} style={{
          border: '1px dashed var(--line-strong)', borderRadius: 'var(--r-md)',
          minHeight: 130, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 'var(--sp-2)', cursor: 'pointer',
          color: 'var(--ink-1)',
        }}>
          <span style={{ fontSize: 22 }}>＋</span>
          <span style={{ fontSize: 'var(--fs-sm)' }}>Link a project</span>
        </div>
        {projects.length === 0 && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Empty>No projects linked yet — link a folder to give the director a job site.</Empty>
          </div>
        )}
      </div>

      {picker && <FolderPicker onPick={(f) => void link(f)} onClose={() => setPicker(false)} />}
    </div>
  );
}
