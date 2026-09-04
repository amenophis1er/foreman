import { useState } from 'react';
import { api, type ProjectSummary } from '../state';
import { AppHeader } from '../ds/shell/AppHeader';
import { BillingBadge, type BillingMode } from '../ds/status/BillingBadge';
import { Empty } from '../ds/core/Empty';
import { Banner } from '../ds/status/Banner';
import { ProjectCard } from '../ds/fleet/ProjectCard';
import { LinkProjectCard } from '../ds/fleet/LinkProjectCard';
import { FolderPicker } from '../ds/overlay/FolderPicker';
import { DropConfirmModal, DropOverlay } from '../ds/overlay/DropConfirmModal';
import { ConfirmDialog } from '../ds/overlay/ConfirmDialog';

type Listing = { path: string; parent: string | null; dirs: string[] };

/** Server-driven state for the controlled FolderPicker. */
function usePicker(onPick: (path: string) => void) {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState<Listing | null>(null);
  const [err, setErr] = useState('');

  const navigate = async (p?: string) => {
    setErr('');
    const r = await api.browse(p);
    if (r.ok) setCur(await r.json());
  };
  const create = async (name: string) => {
    if (!cur) return;
    setErr('');
    const r = await api.mkdir(cur.path, name);
    if (!r.ok) setErr((await r.json()).error);
    else await navigate((await r.json().catch(() => null))?.path ?? cur.path);
  };

  return {
    open,
    show: () => { setOpen(true); void navigate(); },
    close: () => { setOpen(false); setCur(null); },
    props: cur && {
      path: cur.path, parent: cur.parent, dirs: cur.dirs, error: err,
      onNavigate: (p: string) => void navigate(p),
      onCreate: (name: string) => void create(name),
      onPick: (p: string) => { setOpen(false); setCur(null); onPick(p); },
    },
  };
}

export function FleetView({
  projects, connected, activity, auth, onOpen, refresh, theme, onToggleTheme, onSettings,
}: {
  projects: ProjectSummary[]; connected: boolean;
  activity: Record<string, string>;
  auth: { mode: BillingMode; source: string; account?: { email?: string; org?: string } };
  onOpen: (projectId: string) => void; refresh: () => void;
  theme: 'dark' | 'light'; onToggleTheme: () => void; onSettings: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [drop, setDrop] = useState<{ name: string; matches: string[] | null } | null>(null);
  const [unlinking, setUnlinking] = useState<ProjectSummary | null>(null);

  const link = async (folder: string) => {
    const r = await api.linkProject(folder);
    if (r.ok) {
      refresh();
      onOpen((await r.json()).project.id);
    }
  };
  const picker = usePicker((p) => void link(p));

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
      onDrop={(e) => void onDrop(e)}>
      {dragging && <DropOverlay />}

      <AppHeader mode="fleet" subtitle="mission control" theme={theme} onToggleTheme={onToggleTheme} onSettings={onSettings}>
        {!connected && <Banner tone="disconnected" inline>disconnected</Banner>}
        <BillingBadge mode={auth.mode} source={auth.source} account={auth.account} />
      </AppHeader>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 'var(--sp-4)', padding: 'var(--sp-5)', maxWidth: 'var(--fleet-max)', margin: '0 auto',
      }}>
        {projects.map((p) => (
          <ProjectCard key={p.id} name={p.name} folder={p.folder}
            instance={p.claudeInstance?.configDir}
            run={p.activeRun ? {
              mission: p.activeRun.mission,
              costUsd: p.activeRun.costUsd,
              budgetUsd: p.activeRun.budgetUsd,
            } : undefined}
            lastRun={!p.activeRun && p.lastRun && p.lastRun.status !== 'idle' && p.lastRun.status !== 'running'
              ? { ...p.lastRun, status: p.lastRun.status } : undefined}
            activity={p.activeRun ? activity[p.id] : undefined}
            pendingPermissions={p.pendingPermissions}
            pendingQuestions={p.pendingQuestions}
            onOpen={() => onOpen(p.id)}
            onUnlink={() => setUnlinking(p)} />
        ))}
        <LinkProjectCard onClick={picker.show} />
        {projects.length === 0 && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Empty>No projects linked yet — link a folder to give the director a job site.</Empty>
          </div>
        )}
      </div>

      {picker.open && picker.props && (
        <FolderPicker {...picker.props} onClose={picker.close} />
      )}

      {drop && (
        <DropConfirmModal name={drop.name} matches={drop.matches}
          onPick={(p) => { setDrop(null); void link(p); }}
          onClose={() => setDrop(null)} />
      )}

      {unlinking && (
        <ConfirmDialog
          title={`Unlink ${unlinking.name}?`}
          body={'Foreman stops tracking this folder. Run history and its .foreman/ files stay on disk; you can link it again later.'}
          confirmLabel="Unlink" tone="danger" icon="unlink"
          onConfirm={() => {
            const id = unlinking.id;
            setUnlinking(null);
            void api.unlinkProject(id).then(refresh);
          }}
          onCancel={() => setUnlinking(null)} />
      )}
    </div>
  );
}
