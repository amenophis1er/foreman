import { useState } from 'react';
import { api, basisOf, type ProjectSummary } from '../state';
import { AppHeader } from '../ds/shell/AppHeader';
import { BillingBadge, type BillingMode } from '../ds/status/BillingBadge';
import { Button } from '../ds/core/Button';
import { Empty } from '../ds/core/Empty';
import { SectionTitle } from '../ds/core/SectionTitle';
import { Banner } from '../ds/status/Banner';
import { NeedsBoard, summaryText, type NeedItem } from '../ds/fleet/NeedsBoard';
import { FleetRunRow } from '../ds/fleet/FleetRunRow';
import { OutcomeTile } from '../ds/fleet/OutcomeTile';
import { LinkProjectCard } from '../ds/fleet/LinkProjectCard';
import { FleetSearch } from '../ds/fleet/FleetSearch';
import { FolderPicker } from '../ds/overlay/FolderPicker';
import { DropConfirmModal, DropOverlay } from '../ds/overlay/DropConfirmModal';
import { ConfirmDialog } from '../ds/overlay/ConfirmDialog';

type Listing = { path: string; parent: string | null; dirs: string[] };

/**
 * One pending ask as `GET /projects` reports it under `needs[]`. Declared here
 * rather than on `ProjectSummary` until the server field lands; the board
 * tolerates its absence and falls back to the counts.
 */
type ServerNeed = {
  kind: 'permission' | 'question' | 'planner';
  id: string;
  runId?: string;
  text: string;
  options?: string[];
  toolName?: string;
  since?: number;
};
type FleetProject = ProjectSummary & { needs?: ServerNeed[] };

/**
 * Does one project answer to this query?
 *
 * Name, path and mission all match: a fleet accumulates several checkouts of
 * the same repo under different paths, and worktrees whose basenames are
 * identical, so the path is often the only thing that tells two rows apart.
 * Matching the mission means "the fitness studio one" finds it when the
 * project is called `smake`.
 */
function matches(p: ProjectSummary, q: string): boolean {
  const run = p.activeRun ?? p.lastRun;
  return [p.name, p.folder, run?.title, run?.mission]
    .some((f) => f?.toLowerCase().includes(q));
}

/**
 * The board's needs-you items, in reading order: the server's project
 * ordering (urgency first), then oldest ask first within a project.
 *
 * Without `needs` from the server, one count-only strip per project that
 * has anything pending — it can be opened, not answered.
 */
function needsOf(projects: FleetProject[]): NeedItem[] {
  const out: NeedItem[] = [];
  for (const p of projects) {
    if (Array.isArray(p.needs)) {
      const sorted = [...p.needs].sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
      for (const n of sorted) out.push({ ...n, projectId: p.id, projectName: p.name });
      continue;
    }
    const approvals = p.pendingPermissions || 0;
    const questions = p.pendingQuestions || 0;
    if (approvals + questions === 0) continue;
    out.push({
      projectId: p.id, projectName: p.name, kind: 'summary',
      text: summaryText({ approvals, questions, planner: Boolean(p.plannerQuestion) }),
    });
  }
  return out;
}

/** `Response` → the error string the board prints, or null when it went through. */
async function toError(r: Response): Promise<string | null> {
  if (r.ok) return null;
  const body = await r.json().catch(() => ({} as { error?: string }));
  return body.error ?? (r.status === 404 ? 'already answered or timed out' : `HTTP ${r.status}`);
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

const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' } as const;

/**
 * The board. Three questions, top to bottom, in the order they matter:
 * what needs you · what is running · what finished. The card grid that
 * answered all three at once, per project, in whichever order the projects
 * happened to be in, is gone.
 */
export function FleetView({
  projects, connected, activity, update, auth, onOpen, onOpenRun, refresh, theme, onToggleTheme, onSettings, version,
}: {
  projects: ProjectSummary[]; connected: boolean;
  activity: Record<string, string>;
  /** A newer Foreman on npm, when the server could ask. */
  update?: { latest: string; current: string } | null;
  auth: { mode: BillingMode; source: string; account?: { email?: string; org?: string } };
  onOpen: (projectId: string) => void; refresh: () => void;
  /** Open a specific run — where an unfinished one's next act (Resume) lives. */
  onOpenRun?: (projectId: string, runId: string) => void;
  theme: 'dark' | 'light'; onToggleTheme: () => void; onSettings: () => void;
  version?: string;
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
  const shown = (q ? projects.filter((p) => matches(p, q)) : projects) as FleetProject[];

  const needs = needsOf(shown);
  const running = shown
    .filter((p) => p.activeRun)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const recent = shown.filter((p) => !p.activeRun);

  // The header pill counts the whole fleet, not the filtered view: it is the
  // page's status line, and a filter that hides a blocked project must not
  // also hide the fact that one is blocked.
  const totalRunning = projects.filter((p) => p.activeRun).length;
  const totalNeeds = (projects as FleetProject[]).reduce((n, p) =>
    n + (Array.isArray(p.needs) ? p.needs.length : (p.pendingPermissions || 0) + (p.pendingQuestions || 0)), 0);
  const quiet = totalRunning === 0 && totalNeeds === 0;
  // An idle fleet says so in words. Silence looked like a page that had not
  // loaded its other two sections yet, not like a fleet with nothing to do.
  const pill = quiet && projects.length > 0 ? 'all quiet' : [
    totalRunning > 0 ? `${totalRunning} running` : null,
    totalNeeds > 0 ? `${totalNeeds} needs you` : null,
  ].filter(Boolean).join(' · ');

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const entry = e.dataTransfer.items[0]?.webkitGetAsEntry?.();
    if (!entry?.isDirectory) return;
    setDrop({ name: entry.name, matches: null });
    const r = await api.locate(entry.name);
    setDrop({ name: entry.name, matches: r.ok ? (await r.json()).matches : [] });
  };

  // Answering from the board. Each resolves to an error line or null; the
  // strip owns its busy state, the fleet is refreshed either way so a strip
  // that was answered elsewhere in the meantime disappears too.
  const settle = async (r: Promise<Response>) => {
    const err = await toError(await r);
    refresh();
    return err;
  };
  const onPermission = (it: NeedItem, behavior: 'allow' | 'deny') =>
    settle(api.permission(it.id!, behavior));
  const onAnswer = (it: NeedItem, text: string) =>
    settle(api.answer(it.id!, text));
  // The planner's ask is a batch; the board answers the first question only
  // (its text is the strip's text) and `open` handles the rest in the chat.
  // Mirrors `useChat().answer` in state.ts — a direct fetch because that hook
  // is scoped to one project and the board spans them all.
  const onPlanner = (it: NeedItem, text: string) =>
    settle(fetch('/chat/answer', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: it.projectId, id: it.id, answers: { [it.text]: text } }),
    }));

  return (
    <div style={{
      height: '100%', overflowY: 'auto', position: 'relative',
      // Column layout so the empty state can claim the space under the header
      // and centre in it; a populated board still lays out and scrolls normally.
      display: 'flex', flexDirection: 'column',
    }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
      onDrop={(e) => void onDrop(e)}>
      {dragging && <DropOverlay />}

      <AppHeader mode="fleet" subtitle="mission control" theme={theme} onToggleTheme={onToggleTheme} onSettings={onSettings} version={version}>
        {!connected && <Banner tone="disconnected" inline>disconnected</Banner>}
        {/* The page's one status line: what is happening across the fleet —
            including "nothing", said quietly, so the board never reads as
            half-loaded when its first two sections are legitimately empty. */}
        {/* Knowing is most of updating. The pill says so once and stays out
            of the way; the act is `foreman update`, by hand, never under a
            running mission. */}
        {update && (
          <span title={`You run ${update.current}. In a terminal: foreman update — it refuses while a mission is live.`} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 'var(--r-pill)',
            border: '1px solid var(--line)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap',
          }}>
            {update.latest} available · <span style={{ fontFamily: 'var(--font-mono)' }}>foreman update</span>
          </span>
        )}
        {pill && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '2px 10px', borderRadius: 'var(--r-pill)',
            border: `1px solid ${totalNeeds > 0 ? 'var(--status-warning)' : quiet ? 'var(--line)' : 'var(--line-strong)'}`,
            background: totalNeeds > 0 ? 'var(--brand-wash)' : 'transparent',
            fontSize: 'var(--fs-xs)', color: quiet ? 'var(--ink-3)' : 'var(--ink-1)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
          }}>{pill}</span>
        )}
        {/* Only when it warns. A fleet has many projects, each with its own
            provider — some with one per role — so one badge naming one payer
            here says something that is no longer true of the page. The two
            states that still deserve a global flag are the expensive mistake
            (an ambient API key outranking a subscription) and "nothing can
            run at all". A healthy login says nothing; each project's own
            header says who pays for it. */}
        {(auth.mode === 'api-key' || auth.mode === 'none') && (
          <BillingBadge mode={auth.mode} source={auth.source} />
        )}
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

      {/* One project needs no filter; several do, and the row is the same height
          whether or not anything is typed in it. */}
      {projects.length > 1 && (
        <FleetSearch value={query} onChange={setQuery}
          count={shown.length} total={projects.length} />
      )}

      {projects.length === 0 ? (
        // With no projects a board is three empty headings. Centre the
        // invitation instead; once there are projects the board is the right shape.
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 'var(--sp-3)',
          padding: 'var(--sp-5)', textAlign: 'center',
        }}>
          <div style={{ width: '20rem', maxWidth: '100%' }}>
            <LinkProjectCard onClick={picker.show} />
          </div>
          <Empty>No projects linked yet — link a folder to give the director a job site.</Empty>
        </div>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)',
          padding: 'var(--sp-5)', maxWidth: 'var(--fleet-max)', margin: '0 auto', width: '100%', boxSizing: 'border-box',
        }}>
          {shown.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
              <Empty>Nothing matches “{query.trim()}”.</Empty>
              <Button variant="ghost" size="sm" onClick={() => setQuery('')}>Clear filter</Button>
            </div>
          )}

          {/* 0 · Quiet. The two sections above Recent are omitted when empty;
              this one line stands in for both so the reader knows they are
              empty by fact, not missing by accident — and what to do next. */}
          {needs.length === 0 && running.length === 0 && shown.length > 0 && (
            <Empty>
              All quiet — nothing running, nothing waiting on you. Open a project to plan its next mission.
            </Empty>
          )}

          {/* 1 · Needs you. First, always, and answerable here. */}
          {needs.length > 0 && (
            <section style={sectionStyle}>
              <SectionTitle>Needs you · {needs.length}</SectionTitle>
              <NeedsBoard items={needs}
                onPermission={onPermission} onAnswer={onAnswer} onPlanner={onPlanner}
                onOpen={onOpen} />
            </section>
          )}

          {/* 2 · Running. One bordered list; rows, not cards. */}
          {running.length > 0 && (
            <section style={sectionStyle}>
              <SectionTitle>Running · {running.length}</SectionTitle>
              <div style={{
                background: 'var(--bg-card)', border: '1px solid var(--line)',
                borderRadius: 'var(--r-md)', overflow: 'hidden',
              }}>
                {running.map((p, i) => {
                  const r = p.activeRun!;
                  return (
                    <FleetRunRow key={p.id} name={p.name} folder={p.folder}
                      title={r.title} mission={r.mission}
                      activity={activity[p.id]}
                      costUsd={r.costUsd} budgetUsd={r.budgetUsd}
                      costBasis={basisOf(r)} usage={r.usage} turns={r.turns}
                      directorModel={r.directorModel} workerModel={r.workerModel}
                      createdAt={r.createdAt}
                      onOpen={() => onOpen(p.id)}
                      style={i > 0 ? { borderTop: '1px solid var(--line)' } : undefined} />
                  );
                })}
              </div>
            </section>
          )}

          {/* 3 · Recent. What finished, compact, last. */}
          {recent.length > 0 && (
            <section style={sectionStyle}>
              <SectionTitle>Recent · {recent.length}</SectionTitle>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 'var(--sp-3)',
              }}>
                {recent.map((p) => (
                  <OutcomeTile key={p.id} name={p.name} folder={p.folder}
                    lastRun={p.lastRun && p.lastRun.status !== 'idle' && p.lastRun.status !== 'running'
                      ? p.lastRun : null}
                    // A run that ended badly is unfinished business: open it,
                    // where Resume is. A done run's next act is planning.
                    onOpen={() => {
                      const r = p.lastRun;
                      if (r?.id && onOpenRun && (r.status === 'error' || r.status === 'interrupted')) onOpenRun(p.id, r.id);
                      else onOpen(p.id);
                    }}
                    onUnlink={() => setUnlinking(p)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

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
