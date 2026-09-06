import React, { useEffect, useRef, useState } from 'react';
import { FLEET_CHAT_ID, api, basisOf, useChat, type ProjectSummary } from '../state';
import { ChatBar } from '../ds/mission/ChatBar';
import { TranscriptEntry } from '../ds/mission/TranscriptEntry';
import { AppHeader } from '../ds/shell/AppHeader';
import type { BillingMode } from '../ds/status/BillingBadge';
import { Button } from '../ds/core/Button';
import { IconButton } from '../ds/core/IconButton';
import { Icon } from '../ds/core/Icon';
import { Empty } from '../ds/core/Empty';
import { SectionTitle } from '../ds/core/SectionTitle';
import { Banner } from '../ds/status/Banner';
import { NeedsBoard, summaryText, type NeedItem } from '../ds/fleet/NeedsBoard';
import { FleetRunRow } from '../ds/fleet/FleetRunRow';
import { OutcomeTile } from '../ds/fleet/OutcomeTile';
import { LinkProjectCard } from '../ds/fleet/LinkProjectCard';
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
/**
 * The front desk, as the fleet page's right rail.
 *
 * The same fleet planner the phone talks to, same session, so a question
 * asked here continues on Telegram and back. A rail rather than a section
 * because "Needs you" stays first on the board, always: the desk sits
 * beside it, never above it. The conversation scrolls; the composer stays
 * at the foot where a chat's input belongs.
 */
const DESK_KEY = 'foreman.fleet.desk';

/** Remembered per browser: a rail you folded away stays folded. */
function useDeskOpen(): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(DESK_KEY) !== 'closed'; } catch { return true; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem(DESK_KEY, o ? 'closed' : 'open'); } catch { /* private window */ }
    return !o;
  });
  return [open, toggle];
}

function FleetDesk({ onSettings, open, onToggle }: { onSettings: () => void; open: boolean; onToggle: () => void }) {
  const chat = useChat(FLEET_CHAT_ID);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // What was said, not the tool calls behind it: the desk's list_projects
  // calls are furniture, where a project planner's reads are part of the advice.
  const said = chat.entries.filter((e) => e.kind !== 'tool');
  // A reply that arrived while the rail was folded: a dot on the tab until
  // it is opened. Folding is a choice; a reply must not undo it.
  const [unseen, setUnseen] = useState(false);
  const lastSeen = useRef(0);
  useEffect(() => {
    if (open) { lastSeen.current = said.length; setUnseen(false); }
    else if (said.length > lastSeen.current && !chat.thinking) setUnseen(true);
  }, [open, said.length, chat.thinking]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' });
  }, [said.length, chat.thinking, open]);

  const send = async (text: string) => setErr(await chat.send(text));

  if (!open) {
    return (
      <aside style={{ flex: '0 0 auto', borderLeft: '1px solid var(--line)', background: 'var(--bg-panel)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 'var(--sp-2) 4px' }}>
        <button type="button" onClick={onToggle}
          title={chat.thinking ? 'The front desk is replying — open it' : unseen ? 'The front desk answered — open it' : 'Open the front desk (the same conversation as your phone)'}
          aria-label="Open the front desk"
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: 'none', border: 0, padding: '6px 4px',
            cursor: 'pointer', color: 'var(--ink-2)', borderRadius: 'var(--r-sm)', position: 'relative',
          }}>
          <Icon name="chevronLeft" size={14} />
          <span style={{ writingMode: 'vertical-rl', fontSize: 'var(--fs-xs)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Front desk</span>
          {(unseen || chat.thinking) && (
            <span aria-hidden style={{
              position: 'absolute', top: 4, right: 2, width: 7, height: 7, borderRadius: '50%',
              background: chat.thinking ? 'var(--ink-2)' : 'var(--brand)',
            }} />
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside style={{
      width: 'clamp(22rem, 28vw, 30rem)', flex: '0 0 auto', minHeight: 0,
      display: 'flex', flexDirection: 'column',
      borderLeft: '1px solid var(--line)', background: 'var(--bg-panel)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: 'var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3)',
        borderBottom: '1px solid var(--line)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', flex: '0 0 auto',
      }}>
        <span style={{ color: 'var(--ink-0)', fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)' as never }}>Front desk</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>the same conversation as your phone</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--sp-1)', alignItems: 'center', flex: '0 0 auto' }}>
          {chat.costUsd > 0 && <span title="What this conversation has cost. Not charged to any mission." style={{ fontVariantNumeric: 'tabular-nums', marginRight: 'var(--sp-1)' }}>${chat.costUsd.toFixed(2)}</span>}
          {said.length > 0 && !chat.thinking && (
            <Button variant="ghost" size="sm" onClick={() => void chat.clear()} title="Forget this conversation; the next message starts fresh">Forget</Button>
          )}
          <IconButton icon="chevronRight" label="Fold the front desk away" onClick={onToggle} />
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
        {said.length === 0 && !chat.thinking && (
          <Empty>
            Ask how things are going, or say what you want started where. It knows every project, can open a planning
            conversation, propose a mission, or pass a note to a running director. It never starts a run or answers an
            approval for you.
          </Empty>
        )}
        {said.map((e) => (
          <TranscriptEntry key={e.id} agent={e.agent} title={e.title} kind={e.kind} body={e.body} ts={e.ts} />
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ flex: '0 0 auto', padding: 'var(--sp-2) var(--sp-3) var(--sp-3)', borderTop: '1px solid var(--line)' }}>
        <ChatBar busy={chat.thinking} who={chat.who} placeholder="How is everything going?" attach={false}
          hint="Knows the fleet. Never starts a run or answers for you."
          busyHint="The front desk is looking…"
          onSend={(t: string) => void send(t)} onStop={() => void chat.stop()} onChangeModel={onSettings} />
        {err && <Banner tone="error" inline style={{ marginTop: 4 }}>{err}</Banner>}
      </div>
    </aside>
  );
}

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
  projects, connected, activity, auth, onOpen, onOpenRun, refresh, theme, onToggleTheme, onSettings,
  query = '', onQuery, search,
}: {
  /** The header finder's text, owned by the app; the board narrows its cards by it. */
  query?: string; onQuery?: (q: string) => void;
  /** The finder itself, rendered in the header. */
  search?: React.ReactNode;
  projects: ProjectSummary[]; connected: boolean;
  activity: Record<string, string>;
  auth: { mode: BillingMode; source: string; account?: { email?: string; org?: string } };
  onOpen: (projectId: string) => void; refresh: () => void;
  /** Open a specific run — where an unfinished one's next act (Resume) lives. */
  onOpenRun?: (projectId: string, runId: string) => void;
  theme: 'dark' | 'light'; onToggleTheme: () => void; onSettings: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [deskOpen, toggleDesk] = useDeskOpen();
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
      height: '100%', overflow: 'hidden', position: 'relative',
      // Column: the header, then a row of board and desk. The board scrolls
      // on its own so the desk's composer never leaves the screen.
      display: 'flex', flexDirection: 'column',
    }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
      onDrop={(e) => void onDrop(e)}>
      {dragging && <DropOverlay />}

      <AppHeader mode="fleet" subtitle="mission control" theme={theme} onToggleTheme={onToggleTheme} onSettings={onSettings} search={search}>
        {!connected && <Banner tone="disconnected" inline>disconnected</Banner>}
        {/* The page's one status line: what is happening across the fleet —
            including "nothing", said quietly, so the board never reads as
            half-loaded when its first two sections are legitimately empty. */}
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

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* The header's finder also narrows this board. Say so while it does,
          with the way out, since the box that caused it may have lost focus. */}
      {q && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', maxWidth: 'var(--fleet-max)', margin: '0 auto', width: '100%',
          padding: 'var(--sp-4) var(--sp-5) 0', boxSizing: 'border-box', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
        }}>
          <span>Showing projects matching “{query.trim()}” · <span style={{ fontVariantNumeric: 'tabular-nums' }}>{shown.length} of {projects.length}</span></span>
          <Button variant="ghost" size="sm" onClick={() => onQuery?.('')}>Show all</Button>
        </div>
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
              <Empty>No project matches “{query.trim()}”. Runs that do are in the search box above.</Empty>
              <Button variant="ghost" size="sm" onClick={() => onQuery?.('')}>Show all</Button>
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

      </div>
      {/* The front desk, beside the board, once there is a fleet to ask about. */}
      {projects.length > 0 && <FleetDesk onSettings={onSettings} open={deskOpen} onToggle={toggleDesk} />}
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
