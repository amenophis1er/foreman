import { useState } from 'react';
import { api, providerHome, type ProjectSummary } from '../state';
import { AppHeader } from '../ds/shell/AppHeader';
import { BillingBadge, type BillingMode } from '../ds/status/BillingBadge';
import { Button } from '../ds/core/Button';
import { Empty } from '../ds/core/Empty';
import { Banner } from '../ds/status/Banner';
import { ProjectCard } from '../ds/fleet/ProjectCard';
import { LinkProjectCard } from '../ds/fleet/LinkProjectCard';
import { FleetSearch } from '../ds/fleet/FleetSearch';
import { FolderPicker } from '../ds/overlay/FolderPicker';
import { DropConfirmModal, DropOverlay } from '../ds/overlay/DropConfirmModal';
import { ConfirmDialog } from '../ds/overlay/ConfirmDialog';

type Listing = { path: string; parent: string | null; dirs: string[] };

/**
 * Does one project answer to this query?
 *
 * Name, path and mission all match: a fleet accumulates several checkouts of
 * the same repo under different paths, and worktrees whose basenames are
 * identical, so the path is often the only thing that tells two cards apart.
 * Matching the mission means "the fitness studio one" finds it when the
 * project is called `smake`.
 */
function matches(p: ProjectSummary, q: string): boolean {
  const run = p.activeRun ?? p.lastRun;
  return [p.name, p.folder, run?.title, run?.mission]
    .some((f) => f?.toLowerCase().includes(q));
}

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
  const [query, setQuery] = useState('');
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

  // Filtering narrows, it never reorders: the server's urgency ordering
  // survives, so a project blocked on you stays first among whatever is left.
  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter((p) => matches(p, q)) : projects;

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
    <div style={{
      height: '100%', overflowY: 'auto', position: 'relative',
      // Column layout so the empty state can claim the space under the header
      // and centre in it; a populated grid still lays out and scrolls normally.
      display: 'flex', flexDirection: 'column',
    }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
      onDrop={(e) => void onDrop(e)}>
      {dragging && <DropOverlay />}

      <AppHeader mode="fleet" subtitle="mission control" theme={theme} onToggleTheme={onToggleTheme} onSettings={onSettings}>
        {!connected && <Banner tone="disconnected" inline>disconnected</Banner>}
        <BillingBadge mode={auth.mode} source={auth.source} account={auth.account} />
        {/* The fleet's one creative act. As a trailing grid tile it drifted
            further from the eye with every project linked; in the header it
            stays in the same place whether there are two projects or twenty. */}
        {projects.length > 0 && (
          <Button variant="primary" icon="add" onClick={picker.show}
            title="Link a folder as a project (or drop one anywhere on this page)">
            Link project
          </Button>
        )}
      </AppHeader>

      {/* One card needs no filter; several do, and the row is the same height
          whether or not anything is typed in it. */}
      {projects.length > 1 && (
        <FleetSearch value={query} onChange={setQuery}
          count={shown.length} total={projects.length} />
      )}

      {/* With no projects the grid strands a lone card in the top-left of an
          empty page. Centre the invitation instead; once there are projects the
          grid is the right shape again. */}
      <div style={projects.length === 0 ? {
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 'var(--sp-3)',
        padding: 'var(--sp-5)', textAlign: 'center',
      } : {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(var(--card-min), 1fr))',
        gap: 'var(--sp-4)', padding: 'var(--sp-5)', maxWidth: 'var(--fleet-max)', margin: '0 auto',
      }}>
        {shown.map((p) => (
          <ProjectCard key={p.id} name={p.name} folder={p.folder}
            instance={providerHome(p.provider)}
            run={p.activeRun ? {
              mission: p.activeRun.mission,
              title: p.activeRun.title,
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
        {projects.length === 0 && (
          <>
            <div style={{ width: '20rem', maxWidth: '100%' }}>
              <LinkProjectCard onClick={picker.show} />
            </div>
            <Empty>No projects linked yet — link a folder to give the director a job site.</Empty>
          </>
        )}
        {projects.length > 0 && shown.length === 0 && (
          // Spans the grid so the message sits under the field that caused it
          // rather than alone in the first column.
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <Empty>Nothing matches “{query.trim()}”.</Empty>
            <Button variant="ghost" size="sm" onClick={() => setQuery('')}>Clear filter</Button>
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
