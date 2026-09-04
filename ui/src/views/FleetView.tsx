import { useState } from 'react';
import { api, type ProjectSummary } from '../state';
import { BillingBadge, BudgetMeter, Button, Empty, StatusBadge, type AuthMode, type Status } from '../design/ui';
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
      {p.claudeInstance?.configDir && (
        <div style={{
          fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: -4,
        }}>via {p.claudeInstance.configDir}</div>
      )}

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

export function FleetView({ projects, connected, auth, onOpen, refresh }: {
  projects: ProjectSummary[]; connected: boolean;
  auth: { mode: AuthMode; source: string };
  onOpen: (projectId: string) => void; refresh: () => void;
}) {
  const [picker, setPicker] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Browsers only reveal a dropped folder's NAME (never its absolute path),
  // so a drop triggers a server-side search under $HOME and the user
  // confirms among the matches.
  const [drop, setDrop] = useState<{ name: string; matches: string[] | null } | null>(null);

  const link = async (folder: string) => {
    const r = await api.linkProject(folder);
    if (r.ok) {
      refresh();
      onOpen((await r.json()).project.id);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const entry = e.dataTransfer.items[0]?.webkitGetAsEntry?.();
    if (!entry?.isDirectory) return;
    setDrop({ name: entry.name, matches: null });
    const r = await api.locate(entry.name);
    setDrop({ name: entry.name, matches: r.ok ? (await r.json()).matches : [] });
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', position: 'relative' }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
      onDrop={onDrop}>
      {dragging && (
        <div style={{
          position: 'absolute', inset: 8, zIndex: 5, pointerEvents: 'none',
          border: '2px dashed var(--brand)', borderRadius: 'var(--r-md)',
          background: 'rgba(232,176,75,.06)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--brand)', fontSize: 'var(--fs-lg)',
        }}>Drop a folder to link it</div>
      )}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
        padding: 'var(--sp-3) var(--sp-5)', borderBottom: '1px solid var(--line)',
        background: 'var(--bg-panel)',
      }}>
        <h1 style={{ margin: 0, fontSize: 18, color: 'var(--brand)' }}>Foreman</h1>
        <span style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>mission control</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          {!connected && (
            <span style={{ color: 'var(--status-serious)', fontSize: 'var(--fs-sm)' }}>
              ⏻ disconnected
            </span>
          )}
          <BillingBadge mode={auth.mode} source={auth.source} />
        </span>
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

      {drop && (
        <div onClick={(e) => e.target === e.currentTarget && setDrop(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 520, maxHeight: '60vh', display: 'flex', flexDirection: 'column',
            background: 'var(--bg-panel)', border: '1px solid var(--line-strong)',
            borderRadius: 'var(--r-md)', overflow: 'hidden',
          }}>
            <div style={{ padding: 'var(--sp-3)', borderBottom: '1px solid var(--line)' }}>
              <b>📁 {drop.name}</b>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginTop: 2 }}>
                Browsers hide dropped folders' full paths — pick the matching location.
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {drop.matches === null && (
                <div style={{ padding: 'var(--sp-3)', color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>
                  Searching your home folder…
                </div>
              )}
              {drop.matches?.map((m) => (
                <div key={m} role="button"
                  onClick={() => { setDrop(null); void link(m); }}
                  style={{
                    padding: '8px 12px', cursor: 'pointer',
                    fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)',
                  }}>{m}</div>
              ))}
              {drop.matches?.length === 0 && (
                <div style={{ padding: 'var(--sp-3)', color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>
                  No folder named “{drop.name}” found under your home directory —
                  use the folder picker instead.
                </div>
              )}
            </div>
            <div style={{ padding: 'var(--sp-3)', borderTop: '1px solid var(--line)', textAlign: 'right' }}>
              <Button onClick={() => setDrop(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
