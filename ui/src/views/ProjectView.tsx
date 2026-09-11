import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, basisOf, providerHome, reviewedByNames, useChat, useRunHistory, useRunView, useSchedules,
  type Cadence, type CostBasis, type Entry, type ProjectSummary, type RunSummary,
  type RunView as RunViewState, type Schedule, type ScheduleInput, type TokenUsage, withAttachments,
} from '../state';
import { useDeck, useProjectTree } from '../deck';
import { AppHeader } from '../ds/shell/AppHeader';
import { Button } from '../ds/core/Button';
import { Modal, ModalFooter } from '../ds/overlay/Modal';
import { TextInput } from '../ds/forms/TextInput';
import { Textarea } from '../ds/forms/Textarea';
import { Empty } from '../ds/core/Empty';
import { Icon } from '../ds/core/Icon';
import { Banner } from '../ds/status/Banner';
import { StatusBadge } from '../ds/status/StatusBadge';
import { BillingBadge, type BillingMode } from '../ds/status/BillingBadge';
import { BudgetMeter, formatTokens } from '../ds/status/BudgetMeter';
import { RunTimeline } from '../ds/mission/RunTimeline';
import { TranscriptEntry } from '../ds/mission/TranscriptEntry';
import { PlanBoard } from '../ds/mission/PlanBoard';
import { RichText } from '../ds/core/RichText';
import { onSse } from '../sse';
import { Composer, type CrewPreset } from '../ds/mission/Composer';
import { ChatBar } from '../ds/mission/ChatBar';
import { QuestionPicker } from '../ds/mission/QuestionPicker';
import { ProposalCard } from '../ds/mission/ProposalCard';
import { Tabs } from '../ds/core/Tabs';
import { SteerBar } from '../ds/mission/SteerBar';
import { CrewStrip } from '../ds/mission/CrewStrip';
import { RunRow } from '../ds/mission/RunRow';
import { NowStrip, type NowActivity } from '../ds/mission/NowStrip';
import { DoneWhenList, doneWhenLabel, parseDoneWhen } from '../ds/mission/DoneWhenList';
import { FilesPanel } from '../ds/mission/FilesPanel';
import { SchedulesPanel } from '../ds/mission/SchedulesPanel';
import { ScheduleSheet } from '../ds/mission/ScheduleSheet';
import { FolderBrowser } from '../ds/mission/FolderBrowser';
import { DEFAULT_SETTINGS, type Settings } from '../ds/settings/SettingsModal';
import { CrewPanel } from '../ds/mission/CrewPanel';
import type { ModelInfo } from '../ds/forms/ModelSelect';
import { ResumeMenu } from '../ds/mission/ResumeMenu';

/**
 * Where this project's spend actually lands. A pinned provider names itself;
 * anything else is the server's own credential, and saying so is the point —
 * this line sits wherever money is about to be committed.
 */
function billingSource(p: ProjectSummary, serverSource: string): string {
  const home = providerHome(p.provider);
  if (!p.provider || !home) return serverSource;
  if (p.provider.kind === 'claude-code') {
    return p.provider.ownLogin ? `${home} (this project's own login)` : home;
  }
  return `${p.provider.kind} · ${home}`;
}

/** True when the viewport is at least `min` px wide; follows resizes. */
function useWide(min: number): boolean {
  const query = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}

/** Wide enough for the checklist to sit beside the transcript rather than above it. */
const WIDE_PX = 1100;

/**
 * One line of what the crew is doing now, for the strip when nothing is
 * pending. The latest worker `progress` status or the director's latest
 * prose wins — whichever was said most recently — because that is the
 * sentence a human would ask for if they walked up to the desk.
 */
function nowActivity(run: RunViewState): NowActivity | null {
  const running = run.agents.filter((a) => a.status === 'running');
  const workers = running.filter((a) => a.id !== 'director').length;
  const crew = running.length === 0 ? '' : [
    running.some((a) => a.id === 'director') ? 'director' : null,
    workers ? `${workers} worker${workers === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');

  let latest: Entry | null = null;
  for (let i = run.entries.length - 1; i >= 0 && i >= run.entries.length - 40; i--) {
    const e = run.entries[i];
    const isProgress = e.kind === 'system' && e.title.startsWith('progress');
    const isDirectorText = e.kind === 'text' && e.agent === 'director';
    if (isProgress || isDirectorText) { latest = e; break; }
  }
  if (!latest) {
    // Nothing said yet: fall back to the busiest worker's brief.
    const w = running.find((a) => a.id !== 'director' && a.task);
    if (!w) return crew ? { line: 'Crew is starting up', crew } : null;
    return { line: `${w.id}: ${w.task}`, agent: w.id, crew };
  }
  const first = latest.body.split('\n').find((l) => l.trim()) ?? '';
  const line = `${latest.agent}: ${first.replace(/[*_`#>]/g, '').trim().slice(0, 160)}`;
  return { line, agent: latest.agent, crew };
}

/** A one-line toggle with a chevron, for the mission doc and the timeline. Not a Tabs — it hides, it does not switch. */
function Disclosure({ label, open, onToggle, children }: {
  label: React.ReactNode; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'var(--bg-panel)' }}>
      <button type="button" onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 10px',
        background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left',
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)',
      }}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        {label}
      </button>
      {open && <div style={{ padding: '0 10px 10px' }}>{children}</div>}
    </div>
  );
}

/** The one reading column both transcripts share. See `--spine-max`. */
const SPINE_COL: React.CSSProperties = { width: '100%', maxWidth: 'var(--spine-max)', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', boxSizing: 'border-box' };

export type TranscriptOrder = 'newest' | 'oldest';

const ORDER_KEY = 'foreman.transcriptOrder';
const TIMELINE_KEY = 'foreman.timeline';

/** `Sep 3` — the calendar day of a timestamp, for dividers. */
const dayOf = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const RAIL_KEY = 'foreman.railWidth';
const RAIL_MIN = 280;
const RAIL_DEFAULT = 340;

/** The crew toggled on last time, per project — a project habit, not a draft. */
const crewKey = (projectId: string) => `foreman.crew.${projectId}`;

/**
 * The crew roles offered as toggles. Settings holds them under `crewPresets`,
 * and a project's list replaces the global one whole rather than merging —
 * a crew is a set, and half of somebody else's set is nobody's.
 *
 * The two built-ins below mirror `CREW_PRESETS` in src/crew.ts; the ui build
 * cannot import from src/, so the ids and names are kept identical by hand.
 */
const BUILT_IN_CREW: CrewPreset[] = [
  { id: 'reviewer', name: 'Reviewer', kind: 'reviewer', model: 'opus', brief: '', toolPolicy: 'read-only', requiredForDone: true },
  { id: 'security-review', name: 'Security review', kind: 'reviewer', model: 'opus', brief: '', toolPolicy: 'read-only', requiredForDone: false },
];

/** The stored list, project's over global's; nothing stored anywhere = the built-ins. */
function crewPresetsOf(settings: { global: Settings; project?: Settings }): unknown {
  const pick = (s?: Settings) => (s as Record<string, unknown> | undefined)?.crewPresets;
  return pick(settings.project) ?? pick(settings.global);
}

/** Ids no longer offered are dropped: a preset deleted in Settings is gone. */
function readCrew(projectId: string, presets: CrewPreset[]): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(crewKey(projectId)) || 'null');
    if (!Array.isArray(raw)) return [];
    return presets.filter((p) => raw.includes(p.id)).map((p) => p.id);
  } catch { return []; }
}

function writeCrew(projectId: string, ids: string[]): void {
  try { localStorage.setItem(crewKey(projectId), JSON.stringify(ids)); } catch { /* private mode */ }
}

/**
 * Reading order for the transcript, remembered across runs and reloads.
 *
 * Newest-first is the default because most visits to a run are after the fact,
 * where the last thing that happened is the thing you came for. Following a
 * live mission reads better oldest-first, which is one click away and sticks.
 */
function useTranscriptOrder(): [TranscriptOrder, (o: TranscriptOrder) => void] {
  const [order, setOrder] = useState<TranscriptOrder>(() => {
    try {
      return localStorage.getItem(ORDER_KEY) === 'oldest' ? 'oldest' : 'newest';
    } catch {
      return 'newest'; // storage can throw outright in a locked-down browser
    }
  });
  return [order, (o: TranscriptOrder) => {
    setOrder(o);
    try { localStorage.setItem(ORDER_KEY, o); } catch { /* preference is optional */ }
  }];
}

/** Where new entries land, given the reading order. */
function liveEdge(el: HTMLElement, order: TranscriptOrder): number {
  return order === 'newest' ? 0 : el.scrollHeight;
}

function Transcript({ run, filter, jump, order, header }: {
  run: RunViewState; filter: string | null;
  /** Entry to scroll to and flash; `n` forces the effect on repeat clicks. */
  jump: { id: number; n: number } | null;
  order: TranscriptOrder;
  header?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [flashId, setFlashId] = useState<number | null>(null);
  const filtered = filter ? run.entries.filter((e) => e.agent === filter) : run.entries;
  // Entries are stored oldest-first; newest-first is a view, not a re-model.
  const shown = order === 'newest' ? [...filtered].reverse() : filtered;

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = liveEdge(el, order);
  }, [shown.length, order]);

  // Flipping the order makes the old scroll position meaningless — go back to
  // following the live edge rather than stranding the reader mid-history.
  useEffect(() => {
    pinned.current = true;
    const el = box.current;
    if (el) el.scrollTop = liveEdge(el, order);
  }, [order]);

  useEffect(() => {
    if (!jump) return;
    pinned.current = false; // stop auto-scroll from fighting the jump
    // rAF so a filter change from the same click has rendered first.
    const raf = requestAnimationFrame(() => {
      document.getElementById(`entry-${jump.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(jump.id);
    });
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [jump]);

  return (
    <div ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = order === 'newest'
          ? el.scrollTop < 60
          : el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      style={{
        overflowY: 'auto', padding: 'var(--sp-3)', minHeight: 0, flex: 1,
        display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      }}>
      {/* One column of reading width, centred: on a wide window a transcript
          stretched edge to edge read flat, every line the same long shape. */}
      <div style={SPINE_COL}>
      {header}
      {shown.length === 0 && <Empty>Transcript will appear here.</Empty>}
      {shown.map((e) => (
        <div key={e.id} id={`entry-${e.id}`} style={{
          scrollMarginTop: 8, borderRadius: 'var(--r-sm)',
          outline: flashId === e.id ? '2px solid var(--brand)' : 'none',
          transition: 'outline-color var(--dur-fast) var(--ease)',
        }}>
          {/* Tool calls as one quiet line; decisions, asks and the human's
              words keep their cards. Weight follows meaning. */}
          <TranscriptEntry agent={e.agent} title={e.title} dense
            kind={e.kind} body={e.body} ts={e.ts} to={e.to} timing={e.timing}
            review={e.review} costBasis={run.costBasis} />
        </div>
      ))}
      </div>
    </div>
  );
}

/**
 * The planning conversation: transcript, proposal, input.
 *
 * Deliberately reuses the mission transcript's rendering. A planning turn and
 * a mission turn are the same thing on the wire — SDK messages in an event
 * log — and showing them the same way is what makes the handoff read as one
 * continuous story rather than two products bolted together.
 */
/** The project's memory, re-read whenever a run in this project rewrites it. */
function useMemory(projectId: string): { text: string; updatedAt?: number; loaded: boolean } {
  const [m, setM] = useState<{ text: string; updatedAt?: number; loaded: boolean }>({ text: '', loaded: false });
  useEffect(() => {
    let cancelled = false;
    const load = () => api.memory(projectId).then(async (r) => {
      if (cancelled || !r.ok) return;
      const d = await r.json() as { text: string; updatedAt?: number };
      setM({ text: d.text ?? '', updatedAt: d.updatedAt, loaded: true });
    }).catch(() => {});
    void load();
    const unsub = onSse((event, env) => { if (event === 'memory_updated' && env.projectId === projectId) void load(); });
    return () => { cancelled = true; unsub(); };
  }, [projectId]);
  return m;
}

export interface RunService { port: number; label: string; since: number; listening: boolean; ours: boolean }

/**
 * Servers this run exposed, and whether they are still up. Re-read when the
 * run's status changes, because the interesting moment is after it ends:
 * that is when a leftover dev server has nobody left to shut it down and
 * quietly keeps its port for the rest of the day.
 */
function useRunServices(runId: string | null, runStatus: string | undefined) {
  const [list, setList] = useState<RunService[]>([]);
  const load = React.useCallback(() => {
    if (!runId) { setList([]); return; }
    void api.runServices(runId).then(async (r) => {
      if (!r.ok) return;
      const d = await r.json() as { services: RunService[] };
      setList(d.services ?? []);
    }).catch(() => {});
  }, [runId]);
  useEffect(load, [load, runStatus]);
  return { list, refresh: load };
}

/**
 * The leftovers, where the human will be when they notice: on the run that
 * started them. Stop asks the server, which kills the recorded process only
 * if it is still the one holding the port.
 */
function LeftoverServices({ runId, services, onDone }: { runId: string; services: RunService[]; onDone: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const up = services.filter((s) => s.listening);
  if (!up.length) return null;
  const stop = async (port: number) => {
    setBusy(port); setErr('');
    const r = await api.stopService(runId, port).finally(() => setBusy(null));
    if (!r.ok) setErr((await r.json().catch(() => ({ error: 'could not stop it' }))).error);
    onDone();
  };
  return (
    <Banner tone="caution">
      This run left {up.length === 1 ? 'a server' : `${up.length} servers`} running:{' '}
      {up.map((s, i) => (
        <span key={s.port}>
          {i > 0 ? ', ' : ''}
          <span style={{ fontFamily: 'var(--font-mono)' }}>{s.port}</span> ({s.label})
          {s.ours ? (
            <Button variant="ghost" size="sm" disabled={busy === s.port} style={{ marginLeft: 4 }}
              onClick={() => void stop(s.port)}>{busy === s.port ? 'Stopping…' : 'Stop'}</Button>
          ) : (
            <span style={{ color: 'var(--ink-2)' }}> — held by another process now, left alone</span>
          )}
        </span>
      ))}
      {err && <div style={{ marginTop: 4, color: 'var(--ink-2)' }}>{err}</div>}
    </Banner>
  );
}

/**
 * What the project "believes": .foreman/MEMORY.md, as the crew keeps it.
 * Read-only here — the file is the human's to edit with any editor, and the
 * director rewrites it at the end of a mission.
 */
function MemoryPanel({ memory }: { memory: { text: string; updatedAt?: number; loaded: boolean } }) {
  const when = memory.updatedAt ? new Date(memory.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)' }}>
        Memory{when && <span style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>{when}</span>}
      </div>
      {memory.loaded && !memory.text.trim() ? (
        <Empty>Nothing yet. The director writes <span style={{ fontFamily: 'var(--font-mono)' }}>.foreman/MEMORY.md</span> at the end of a mission: how to run and test the project, ports and paths, conventions, traps. Every later crew and the planner read it first.</Empty>
      ) : memory.text.trim() ? (
        <div title="The project's notes for the next crew — .foreman/MEMORY.md. Edit it with any editor." style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-card)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)', maxHeight: '40vh', overflowY: 'auto' }}>
          <RichText text={memory.text} />
        </div>
      ) : null}
    </section>
  );
}

type PrDraft = {
  title: string; body: string; branch: string; base: string; commits: number | null; remote: string;
  /** Where the mission was branched from, when that is not where the request can go. */
  branchedFrom?: string; baseFellBack?: boolean;
  compareUrl: string | null; gh: { present: boolean; authed: boolean }; pr: string | null; onBranch: boolean; dirty: boolean;
};

/**
 * The pull request sheet: the one outward-facing act, behind a button and a
 * look at what will be sent. Foreman drafts title and body from the run;
 * the human edits and presses Create. Push and PR run as the user, with
 * their git and gh; without gh (or off GitHub) it pushes and hands back the
 * compare link to finish in the browser.
 */
function PullRequestSheet({ runId, onClose, onDone }: { runId: string; onClose: () => void; onDone: (url?: string) => void }) {
  const [draft, setDraft] = useState<PrDraft | null>(null);
  const [err, setErr] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; method?: string; note?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.prDraft(runId).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (cancelled) return;
      if (!r.ok) { setErr(d.error ?? `HTTP ${r.status}`); return; }
      setDraft(d as PrDraft); setTitle(d.title); setBody(d.body);
    }).catch(() => { if (!cancelled) setErr('Could not reach the server.'); });
    return () => { cancelled = true; };
  }, [runId]);

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.openPr(runId, title, body);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error ?? `HTTP ${r.status}`); return; }
      setResult(d);
      onDone(d.url);
    } finally { setBusy(false); }
  };

  const viaGh = draft?.gh.present && draft.gh.authed && /github\.com/.test(draft.remote);
  return (
    <Modal width={640} onClose={busy ? undefined : onClose}>
      <div style={{ padding: 'var(--sp-3)', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontWeight: 'var(--fw-semibold)' }}>Open a pull request</span>
        {draft && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
            {draft.branch} → {draft.base}{draft.commits !== null ? ` · ${draft.commits} commit${draft.commits === 1 ? '' : 's'}` : ''} · {draft.remote}
          </span>
        )}
      </div>
      <div style={{ padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', overflowY: 'auto', minHeight: 0 }}>
        {!draft && !err && <Empty>Reading the branch…</Empty>}
        {draft && !result && (
          <>
            {draft.pr && <Banner tone="readonly" inline>A pull request already exists for this branch: <a href={draft.pr} target="_blank" rel="noopener noreferrer">{draft.pr}</a></Banner>}
            {draft.baseFellBack && (
              <Banner tone="caution" inline>
                This mission was branched from <span style={{ fontFamily: 'var(--font-mono)' }}>{draft.branchedFrom}</span>,
                which is not on the remote — a previous mission's branch, most likely. The request targets{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{draft.base}</span> instead, so it carries that
                mission's commits too until its own branch is merged.
              </Banner>
            )}
            {!draft.onBranch && <Banner tone="caution" inline>The folder is currently on another branch. The push sends {draft.branch} as it is in git, which is fine; just know what you are looking at locally.</Banner>}
            {draft.dirty && draft.onBranch && <Banner tone="caution" inline>There are uncommitted changes in the folder. They are not part of this pull request.</Banner>}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
              Title
              <TextInput value={title} onChange={setTitle} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
              Body
              <Textarea size="mission" value={body} onChange={setBody} />
            </label>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
              Create pushes <span style={{ fontFamily: 'var(--font-mono)' }}>{draft.branch}</span> to origin as you, with your own git credentials
              {viaGh ? <>, then opens the pull request with <span style={{ fontFamily: 'var(--font-mono)' }}>gh</span>.</>
                : <>, then gives you the link to finish the pull request in the browser{draft.gh.present ? '' : ' (gh is not installed)'}.</>}
              {' '}Nothing is merged.
            </span>
          </>
        )}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <span>{result.method === 'gh' ? 'Pull request opened.' : 'Branch pushed. Finish the pull request in the browser:'}</span>
            {result.url && <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{result.url}</a>}
            {result.note && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{result.note}</span>}
          </div>
        )}
        {err && <Banner tone="error" inline>{err}</Banner>}
      </div>
      <ModalFooter>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose} disabled={busy}>{result ? 'Close' : 'Cancel'}</Button>
        {draft && !result && (
          <Button variant="primary" disabled={busy || !title.trim()} onClick={() => void create()}>
            {busy ? 'Pushing…' : viaGh ? 'Push & create pull request' : 'Push & get the link'}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

function PlanPane({
  chat, folder, starting, error, errorAction, models, modelsLoading, modelsNote, modelsInheritNote, onStart, onCompose, hasRuns, projectId, onSettings,
  crewPresets = [], crew = [], onCrewChange,
  recent = [], runsOn, onOpenRun, onForkRun, forking = false,
}: {
  /** Offered beside the error when the human can override the refusal. */
  errorAction?: { label: string; onClick: () => void };
  /** The project's latest runs, newest first, for the empty state's "pick up where you left off". */
  recent?: RunSummary[];
  /** "missions here run on … · cap $… · Change", under the invitation. */
  runsOn?: React.ReactNode;
  onOpenRun?: (runId: string) => void;
  /** "Plan the next step" from a finished run: a seeded conversation replaces this empty state. */
  onForkRun?: (runId: string) => void;
  forking?: boolean;
  chat: ReturnType<typeof useChat>;
  folder: string;
  starting: boolean;
  error: string;
  models: ModelInfo[] | null;
  modelsLoading?: boolean; modelsNote?: string; modelsInheritNote?: string;
  /**
   * The full start shape, not just brief and budget. The proposal card is the
   * moment of commitment, and a mission committed without a browser it needs
   * or on a model nobody chose is the mistake that costs an hour to notice —
   * so the card carries every lever the composer has.
   */
  onStart: (v: {
    mission: string; budget: number; directorModel?: string; workerModel?: string;
    directorProviderId?: string; workerProviderId?: string; browserTools?: boolean;
    crew?: string[];
    attachments?: File[];
  }) => void;
  /** The crew roles Settings offers, and the ones this project last used —
   *  the proposal's own `crew` suggestion wins over the remembered set. */
  crewPresets?: CrewPreset[];
  crew?: string[];
  onCrewChange?: (ids: string[]) => void;
  /** "Skip the talk": open the mission composer instead. */
  onCompose: () => void;
  /** The project has finished runs — the empty state can point at "Plan the next step". */
  hasRuns?: boolean;
  projectId: string;
  /** Opens Settings, where the planner's model lives. */
  onSettings: () => void;
}) {
  const [sendErr, setSendErr] = useState('');
  // The empty state's input is controlled so a starter can fill it: a starter
  // is a draft to read and edit, not a message sent behind the human's back.
  const [draft, setDraft] = useState('');
  const [draftKey, setDraftKey] = useState(0);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const useStarter = (q: string) => { setDraft(q); setDraftKey((k) => k + 1); };
  // Files ride along as paths in the project folder; the planner reads them.
  const send = async (text: string, files: File[] = []) => {
    setSendErr('');
    try { await chat.send(await withAttachments(projectId, text, files)); }
    catch (e) { setSendErr((e as Error).message); }
  };
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.entries.length, chat.proposal, chat.thinking]);

  const fresh = chat.entries.length === 0 && !chat.thinking && !chat.question && !chat.proposal;
  if (fresh) {
    // Nothing said yet: the input is the page. Centre the invitation and the
    // input together; the bar drops to the bottom once there is a conversation
    // above it to read.
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ margin: 'auto', width: '100%', maxWidth: 'var(--composer-max)', padding: 'var(--sp-4) var(--sp-3)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
            <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>
              {recent.length ? 'Pick up where you left off, or start something new' : 'What should this project do next?'}
            </span>
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-2)' }}>
              {recent.length
                ? 'Open a run to see what it built, plan the next step from it, or describe something new below.'
                : 'Describe it, paste a spec or a screenshot, or pick a starter and edit it before sending.'}
            </span>
          </div>
          {/* A project with history leads with it: what happened, and the two
              ways on from each run. The full list stays in the rail's Runs tab. */}
          {recent.length > 0 && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--bg-card)', overflow: 'hidden' }}>
              {(showAllRuns ? recent : recent.slice(0, 4)).map((r, i) => {
                const finished = r.status !== 'running';
                const when = new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                return (
                  <div key={r.id} style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 'var(--sp-3)',
                    padding: 'var(--sp-2) var(--sp-3)', borderTop: i > 0 ? '1px solid var(--line)' : 'none',
                  }}>
                    <button type="button" onClick={() => onOpenRun?.(r.id)} title="Open this run"
                      style={{ minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.title || r.mission.split('\n')[0]}
                      </span>
                      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', fontVariantNumeric: 'tabular-nums' }}>
                        <StatusBadge status={r.status} />
                        <span>{when}</span>
                        {basisOf(r) === 'priced' && <span>${r.costUsd.toFixed(2)}</span>}
                      </span>
                    </button>
                    <span style={{ display: 'inline-flex', gap: 'var(--sp-1)', flex: '0 0 auto' }}>
                      <Button variant="ghost" size="sm" onClick={() => onOpenRun?.(r.id)}>Open</Button>
                      {finished && (
                        <Button size="sm" icon="steer" disabled={forking || chat.thinking}
                          title="Start a planning conversation seeded with what this run built"
                          onClick={() => onForkRun?.(r.id)}>Plan the next step</Button>
                      )}
                    </span>
                  </div>
                );
              })}
              {recent.length > 4 && (
                <div style={{ borderTop: '1px solid var(--line)', padding: '4px var(--sp-2)' }}>
                  <Button variant="ghost" size="sm" onClick={() => setShowAllRuns((v) => !v)}>
                    {showAllRuns ? 'Show the latest four' : `Show all ${recent.length} runs`}
                  </Button>
                </div>
              )}
            </div>
          )}
          {/* Starters: each is a draft first message, edited before sending.
              A project with history gets them as one quiet row; the runs
              above are the better starting point. */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${recent.length ? 150 : 200}px, 1fr))`, gap: 'var(--sp-2)' }}>
            {[
              ...(recent.length ? [] : [{ t: 'Survey the project', q: 'Read this project and tell me what it is, how it is built, and what state it is in.' }]),
              { t: 'Find risks worth a mission', q: 'Audit this project for bugs, security holes and missing tests. Rank what you find and propose the one mission most worth running first.' },
              { t: 'Scope a feature', q: 'I have a feature in mind. Ask me what you need to know to scope it, then draft the mission.' },
              { t: 'Plan a refactor', q: 'Where is this codebase hardest to change? Propose one contained refactor with clear DONE WHEN criteria.' },
            ].map((s) => (
              <button key={s.t} type="button" onClick={() => useStarter(s.q)} disabled={chat.thinking} title={recent.length ? s.q : undefined} style={{
                textAlign: 'left', padding: recent.length ? '6px 10px' : '8px 10px', background: 'var(--bg-card)', border: '1px solid var(--line)',
                borderRadius: 'var(--r-sm)', cursor: 'pointer', font: 'inherit', color: 'inherit',
                display: 'flex', flexDirection: 'column', gap: 2,
              }}>
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--ink-0)' }}>{s.t}</span>
                {!recent.length && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', lineHeight: 'var(--lh)' }}>{s.q}</span>}
              </button>
            ))}
          </div>
          <ChatBar key={draftKey} value={draft} onChange={setDraft} busy={chat.thinking} who={chat.who}
            onSend={(t, f) => void send(t, f)} onStop={() => void chat.stop()} onChangeModel={onSettings} autoFocus />
          {sendErr && <Banner tone="error" inline>{sendErr}</Banner>}
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textAlign: 'center' }}>
            Planning reads the project and never changes it — a mission does that. Know what you want already? <b style={{ color: 'var(--ink-1)' }}>New mission</b>, top right.
          </span>
          {runsOn && <div style={{ display: 'flex', justifyContent: 'center' }}>{runsOn}</div>}
        </div>
      </div>
    );
  }

  return (
    <>
      <div ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--sp-3)',
          display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
        }}>
        <div style={SPINE_COL}>
        {chat.entries.map((e, i) => {
          // Entries carry only a clock time; a conversation picked up days
          // later read as if it happened this minute. A quiet line marks
          // each day the talk crossed, and today's is not marked.
          const day = dayOf(e.ts);
          const prev = i > 0 ? dayOf(chat.entries[i - 1].ts) : null;
          return (
            <React.Fragment key={e.id}>
              {(day !== prev && (i > 0 || day !== dayOf(Date.now()))) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', margin: '4px 0' }}>
                  <span style={{ flex: 1, borderTop: '1px solid var(--line)' }} />
                  <span>{day === dayOf(Date.now()) ? 'today' : day}</span>
                  <span style={{ flex: 1, borderTop: '1px solid var(--line)' }} />
                </div>
              )}
              <TranscriptEntry agent={e.agent} title={e.title} kind={e.kind} body={e.body} ts={e.ts} />
            </React.Fragment>
          );
        })}
        {chat.proposal && (
          <ProposalCard
            mission={chat.proposal.mission}
            doneWhen={chat.proposal.doneWhen}
            budgetUsd={chat.proposal.budgetUsd}
            rationale={chat.proposal.rationale}
            browser={chat.proposal.browser}
            directorModel={chat.proposal.directorModel}
            workerModel={chat.proposal.workerModel}
            directorProviderId={chat.proposal.directorProviderId}
            workerProviderId={chat.proposal.workerProviderId}
            modelRationale={chat.proposal.modelRationale}
            crewPresets={crewPresets}
            crew={chat.proposal.crew ?? crew}
            onCrewChange={onCrewChange}
            models={models} modelsLoading={modelsLoading}
            modelsNote={modelsNote} modelsInheritNote={modelsInheritNote}
            busy={starting} error={error} errorAction={errorAction}
            onStart={(v) => onStart(v)}
            onDismiss={chat.dismissProposal} />
        )}
        </div>
      </div>
      <div style={{ padding: 'var(--sp-2) var(--sp-3) var(--sp-3)', flex: '0 0 auto', width: '100%', maxWidth: 'var(--spine-max)', margin: '0 auto', boxSizing: 'border-box' }}>
        {/* A pending question takes the input box's place rather than sitting
            above it: it IS the input right now, and two ways to reply to the
            same thing side by side would be a real question about which one
            to use. Typing still works — the server routes it as the answer. */}
        {chat.question ? (
          <QuestionPicker
            questions={chat.question.questions}
            askedAt={chat.question.askedAt}
            who={chat.who}
            onAnswer={(answers) => void chat.answer(chat.question!.id, answers)}
            onFreeText={(t) => void send(t)} />
        ) : (
          <ChatBar busy={chat.thinking} who={chat.who} onSend={(t, f) => void send(t, f)} onStop={() => void chat.stop()} onChangeModel={onSettings} />
        )}
        {sendErr && <Banner tone="error" inline style={{ marginTop: 4 }}>{sendErr}</Banner>}
        {/* The conversation's own line, under the input where its actions are:
            what it has cost, and the way to start over. Clearing waits for a
            reply in flight — the server refuses mid-turn — and says so. */}
        {(chat.costUsd > 0 || chat.entries.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '4px 2px 0', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            {chat.costUsd > 0 && (
              <span title="What this conversation has cost so far. Planning is not charged to any mission budget."
                style={{ fontVariantNumeric: 'tabular-nums' }}>
                conversation ${chat.costUsd.toFixed(3)}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {chat.thinking && (
              <Button variant="ghost" size="sm" icon="close" title="Stop the planner and discard the rest of this reply"
                onClick={() => void chat.stop()}>Stop</Button>
            )}
            {chat.entries.length > 0 && (
              <Button variant="ghost" size="sm" icon="close" disabled={chat.thinking}
                title={chat.thinking ? 'The planner is replying — clear once it has answered.' : 'Forget this conversation and start a new one'}
                onClick={() => void chat.clear()}>
                {chat.thinking ? 'Clear (after this reply)' : 'Clear conversation'}
              </Button>
            )}
          </div>
        )}
      </div>
      <button type="button" onClick={onCompose} style={{
        flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6,
        margin: '0 auto var(--sp-3)', padding: '6px 10px',
        width: 'calc(100% - 2 * var(--sp-3))', maxWidth: 'calc(var(--spine-max) - 2 * var(--sp-3))', boxSizing: 'border-box',
        background: 'none', border: '1px dashed var(--line-strong)', borderRadius: 'var(--r-sm)',
        cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textAlign: 'left',
      }}>
        <Icon name="write" size={12} />
        Or skip the talk: describe the mission and start it
        <Icon name="chevronRight" size={12} style={{ marginLeft: 'auto' }} />
      </button>
    </>
  );
}

/**
 * Where an isolated mission worked, and the way to reclaim the disk.
 *
 * A worktree run never touched the project folder — it had a checkout of its
 * own under Foreman's home — so the path is the answer to "where is the work",
 * which the branch pill alone does not give. Removing it is refused by the
 * server while the run is alive, and refused again when the branch holds
 * commits its base does not: that second refusal comes back as a sentence to
 * read, and the same button then offers to go ahead anyway. Two clicks, no
 * modal — the warning is the confirmation.
 *
 * Once `removedAt` is stamped the checkout is gone for good, so the line turns
 * past tense and drops the button: offering to remove a directory Foreman
 * already reclaimed only earns a success message about nothing.
 */
function WorktreeLine({ r, live, onRemoved }: {
  r: RunSummary; live: boolean; onRemoved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warning, setWarning] = useState('');
  const [gone, setGone] = useState(false);
  const w = r.worktree!;

  const remove = async (force: boolean) => {
    setBusy(true); setErr('');
    try {
      const res = await api.removeWorktree(r.id, force);
      if (res.ok) { setGone(true); setWarning(''); onRemoved?.(); return; }
      const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
      if (body.code === 'unmerged') setWarning(body.error ?? 'This branch has commits its base does not have.');
      else setErr(body.error ?? `HTTP ${res.status}`);
    } catch { setErr('could not reach the server'); }
    finally { setBusy(false); }
  };

  if (w.removedAt) {
    const when = new Date(w.removedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (
      <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
        <span>
          Ran in a worktree at{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)', wordBreak: 'break-all' }}>{w.path}</span>
          , removed {when}.
        </span>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
      <span>
        Ran in a worktree at{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)', wordBreak: 'break-all' }}>{w.path}</span>
        , made from <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)', wordBreak: 'break-all' }}>{w.repo}</span>.
      </span>
      {gone ? <span>Worktree removed.</span> : (
        <>
          {warning && <span style={{ color: 'var(--status-warning)' }}>{warning}</span>}
          <span>
            <Button variant={warning ? 'danger' : 'ghost'} size="sm" icon="close" disabled={busy || live}
              title={live
                ? 'This mission is still running in it — its worktree can be removed once it ends.'
                : warning ? 'Remove the worktree and its branch anyway' : `Remove ${w.path}. The project folder is untouched.`}
              onClick={() => void remove(Boolean(warning))}>
              {busy ? 'Removing…' : warning ? 'Remove anyway' : 'Remove worktree'}
            </Button>
          </span>
          {err && <span style={{ color: 'var(--status-critical)' }}>{err}</span>}
        </>
      )}
    </div>
  );
}

/**
 * Key run properties (models, budget, browser), pulled from run metadata.
 *
 * Two of them are editable while the run is live, and only two, because only
 * those two genuinely bind mid-run: a worker spawned from now on reads
 * `browserTools` at spawn, and the budget cap re-reads its figure on every
 * cost update. Offering a control that silently does nothing until some later
 * restart would be worse than not offering it, so the rest stay read-only and
 * the browser row says plainly that the director itself catches up on resume.
 */
function RunDetails({ r, live, liveCost, liveBasis, liveUsage, liveTurns, onChanged }: {
  r: RunSummary; live?: boolean; liveCost?: number; liveBasis?: CostBasis;
  liveUsage?: TokenUsage | null; liveTurns?: number; onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const editable = Boolean(live) && r.status === 'running';

  const patch = async (p: { browserTools?: boolean; budgetUsd?: number }) => {
    setBusy(true); setErr('');
    try { await api.updateRun(r.id, p); onChanged?.(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const costBasis = liveBasis ?? basisOf(r);
  const usage = liveUsage ?? r.usage ?? null;
  const turns = liveTurns ?? r.turns;
  const rows: Array<[string, string]> = [
    ['director', r.directorModel || 'default'],
    ['workers', r.workerModel || 'default'],
    // Same honesty rule as BudgetMeter: a run Foreman cannot price never gets
    // a dollar sign, even in this plain key/value list — tokens (and turns, if
    // known) stand in for the figure this run genuinely has no price for.
    // There is room for words here, unlike on a fleet card, so `unpriced`
    // says what it is rather than leaving the reader to infer "free".
    ['budget', costBasis === 'priced'
      ? `$${((liveCost ?? r.costUsd) || 0).toFixed(2)} / $${r.budgetUsd.toFixed(2)}`
      : `${formatTokens(usage?.inputTokens ?? 0)} in · ${formatTokens(usage?.outputTokens ?? 0)} out`
        + `${typeof turns === 'number' ? ` · ${turns} turn${turns === 1 ? '' : 's'}` : ''}`
        + (costBasis === 'unpriced' ? ' · cost not tracked' : ' · no per-token cost')],
  ];
  const valueStyle = {
    color: 'var(--ink-1)', fontFamily: 'var(--font-mono)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  } as const;
  return (
    <div style={{ marginTop: 8, fontSize: 'var(--fs-xs)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2 }}>
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <span style={{ color: 'var(--ink-2)' }}>{k}</span>
            <span style={valueStyle}>{v}</span>
          </React.Fragment>
        ))}
        <span style={{ color: 'var(--ink-2)' }}>browser</span>
        {editable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void patch({ browserTools: !r.browserTools })}
            title={r.browserTools
              ? 'Turn off. No worker spawned after this gets a browser.'
              : 'Turn on. Workers spawned after this get a headless browser; the director itself gains it when the run is resumed.'}
            style={{
              ...valueStyle, justifySelf: 'start', background: 'none', padding: 0,
              border: 'none', borderBottom: '1px dashed var(--line-strong)',
              cursor: busy ? 'wait' : 'pointer', font: 'inherit',
              fontFamily: 'var(--font-mono)', color: 'var(--ink-1)',
            }}
          >{r.browserTools ? 'on' : 'off'}</button>
        ) : <span style={valueStyle}>{r.browserTools ? 'on' : 'off'}</span>}
        {r.resumes ? (
          <>
            <span style={{ color: 'var(--ink-2)' }}>resumes</span>
            <span style={valueStyle}>{r.resumes}</span>
          </>
        ) : null}
      </div>
      {r.worktree && <WorktreeLine r={r} live={Boolean(live)} onRemoved={onChanged} />}
      {err && <div style={{ marginTop: 4, color: 'var(--status-critical)' }}>{err}</div>}
    </div>
  );
}
type RailTab = import('../state').RailTab;

export function ProjectView({
  p, models, modelsLoading, modelsNote, modelsInheritNote, routeRunId, onSelectRun, routeTab, onSelectTab, onBack,
  refreshFleet, auth, theme, onToggleTheme, onSettings, settings, search,
}: {
  /** The header finder, rendered by the app. */
  search?: React.ReactNode;
  p: ProjectSummary; models: ModelInfo[] | null;
  modelsLoading?: boolean; modelsNote?: string; modelsInheritNote?: string;
  auth: { mode: BillingMode; source: string; account?: { email?: string; org?: string } };
  routeRunId: string | null; onSelectRun: (runId: string | null) => void;
  /** The rail tab lives in the URL, so a Files view can be linked and survives refresh. */
  routeTab: RailTab; onSelectTab: (tab: RailTab) => void;
  onBack: () => void; refreshFleet: () => void;
  theme: 'dark' | 'light'; onToggleTheme: () => void; onSettings: (section?: 'provider') => void;
  /** Saved settings, for the rail's glance: global and this project's overlay. */
  settings: { global: Settings; project?: Settings };
}) {
  const history = useRunHistory(p.id);
  const memory = useMemory(p.id);
  const schedules = useSchedules(p.id);
  // null = closed · 'new' = create · a schedule = edit it.
  const [scheduleSheet, setScheduleSheet] = useState<'new' | Schedule | null>(null);
  /**
   * Every schedule action answers with the server's own sentence, or null when
   * it worked — a "Run now" refused because a mission is already running here
   * (409) is a fact the human needs, not something to swallow.
   */
  const scheduleSaid = async (call: Promise<Response>): Promise<string | null> => {
    const r = await call.catch(() => null);
    if (!r) return 'could not reach the server';
    if (!r.ok) return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
    await schedules.reload();
    return null;
  };
  const effectiveSettings = { ...DEFAULT_SETTINGS, ...settings.global, ...(settings.project ?? {}) } as Settings;
  const settingOverrides = Object.keys(settings.project ?? {});
  const branchPerMission = (effectiveSettings as Record<string, unknown>).gitBranchPerMission !== false;
  // The crew on offer, and the crew this project was last started with. The
  // remembered ids are filtered against what Settings still offers on read.
  // `settings` is rebuilt every render, so memoise on the stored array itself:
  // the effect below must not fire on every render.
  const storedCrewPresets = crewPresetsOf(settings);
  const crewPresets = useMemo<CrewPreset[]>(
    () => (Array.isArray(storedCrewPresets) ? storedCrewPresets as CrewPreset[] : BUILT_IN_CREW),
    [storedCrewPresets],
  );
  const [crew, setCrew] = useState<string[]>(() => readCrew(p.id, crewPresets));
  useEffect(() => { setCrew(readCrew(p.id, crewPresets)); }, [p.id, crewPresets]);
  const rememberCrew = (ids: string[]) => { setCrew(ids); writeCrew(p.id, ids); };
  // What a mission here will run on, in one line. The rail's settings block
  // said the same in eight rows; the gear is the way to change it.
  const runsOnLine = (
    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
      <span>missions here run on</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)' }}>{String(effectiveSettings.directorModel ?? 'opus')} · {String(effectiveSettings.workerModel ?? 'sonnet')}</span>
      <span>· cap</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)' }}>${String(effectiveSettings.budgetCap ?? 6)}</span>
      {p.git?.repo && <span>· {branchPerMission ? 'each on its own branch' : `on ${p.git.branch} directly`}</span>}
      {settingOverrides.length > 0 && <span>· {settingOverrides.length} project override{settingOverrides.length === 1 ? '' : 's'}</span>}
      <Button variant="ghost" size="sm" icon="settings" onClick={onSettings}>Change…</Button>
    </span>
  );
  // Every mission live here, newest first. A project isolating its missions in
  // worktrees runs several at once, so "the" active run is only the newest;
  // `activeRun` alone is what an un-upgraded server still sends.
  const liveRuns = p.activeRuns ?? (p.activeRun ? [p.activeRun] : []);
  const liveKey = liveRuns.map((r) => r.id).join(',');
  const liveIds = useMemo(() => new Set(liveKey ? liveKey.split(',') : []), [liveKey]);
  const newestLiveId = liveRuns[0]?.id ?? null;
  // Room for one more mission here. A project isolating its missions in
  // worktrees may run several at once; a shared checkout has a limit of 1, so
  // this is false the moment anything is live and such a project behaves
  // exactly as before. A server that does not send the limit yet reads as 1.
  const missionLimit = p.missionLimit ?? 1;
  const spareCapacity = liveRuns.length < missionLimit;
  // The selected run lives in the URL so a refresh restores the same view.
  const selectedRunId = routeRunId;
  const setSelectedRunId = onSelectRun;
  // Idle projects open on the conversation: the composer asks for a
  // well-specified brief at the moment you know least, which is the wrong
  // order. Writing one directly stays one click away, folded under the chat.
  // Declared here because the selection effect below has to know about it.
  const [composeOpen, setComposeOpen] = useState(false);
  const seenLive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const started = [...liveIds].find((id) => !seenLive.current.has(id));
    seenLive.current = new Set(liveIds);
    // Snap to a mission that has just started, and to the newest live one when
    // nothing is on screen — but never over a human's own choice: with two
    // live runs, selecting the other one is how you switch between them, and
    // the newest must not steal the page back.
    if (selectedRunId !== null) { if (!started || liveIds.has(selectedRunId)) return; }
    // Nothing selected because the human walked off a live run to write the
    // next mission (a project isolating missions can run several): the newest
    // live run must not pull the page back out from under the composer. A run
    // that has just started still wins — that is the one being written. Only
    // where there is room for it: with no spare capacity there is no composer
    // to protect, and the newest run must claim the page as it always did.
    else if (composeOpen && spareCapacity && !started) return;
    if (started ?? newestLiveId) onSelectRun((started ?? newestLiveId)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, selectedRunId]);

  const viewingLive = selectedRunId !== null && liveIds.has(selectedRunId);
  // While a mission runs in the shared checkout, the project folder is its
  // workspace: a commit the human makes there lands on the mission's branch,
  // and anything left uncommitted joins the mission's closing commit. Said of
  // the run being looked at, since several may be live at once.
  const heldBranch = viewingLive
    ? history.find((r) => r.id === selectedRunId && !r.worktree)?.git?.branch
    : undefined;
  const run = useRunView(selectedRunId, viewingLive);
  const leftovers = useRunServices(selectedRunId, run.runStatus);
  const selectedRun = history.find((r) => r.id === selectedRunId);
  const isRunning = viewingLive && run.runStatus === 'running';
  const [filter, setFilter] = useState<string | null>(null);
  const [jump, setJump] = useState<{ id: number; n: number } | null>(null);
  const railTab = routeTab;
  const setRailTab = onSelectTab;
  // The rail's width is the reader's, dragged from its left edge and kept in
  // this browser. Bounded so neither the transcript nor the rail can vanish.
  const [railWidth, setRailWidthState] = useState<number>(() => {
    try { const n = Number(localStorage.getItem(RAIL_KEY)); return n >= RAIL_MIN ? n : RAIL_DEFAULT; } catch { return RAIL_DEFAULT; }
  });
  const setRailWidth = (n: number) => {
    const max = Math.max(RAIL_MIN, Math.floor(window.innerWidth * 0.5));
    const v = Math.min(max, Math.max(RAIL_MIN, Math.round(n)));
    setRailWidthState(v);
    try { localStorage.setItem(RAIL_KEY, String(v)); } catch { /* private mode */ }
  };
  const startRailDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = railWidth;
    const onMove = (ev: PointerEvent) => setRailWidth(startW + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const jumpTo = (e: { id?: string | number; agent: string }) => {
    if (typeof e.id !== 'number') return;
    if (filter && filter !== e.agent) setFilter(null); // entry must be visible
    setJump({ id: e.id, n: Date.now() });
  };
  // Filtering is a transcript operation wherever it is triggered from.
  const toggleFilter = (a: string) => setFilter(filter === a ? null : a);
  const [resuming, setResuming] = useState(false);
  const [order, setOrder] = useTranscriptOrder();
  // Open unless this browser closed it: the swimlanes are the run's shape at a
  // glance, and the human asked for them up front. Remembered like the order.
  const [showTimeline, setShowTimelineState] = useState<boolean>(() => {
    try { return localStorage.getItem(TIMELINE_KEY) !== 'closed'; } catch { return true; }
  });
  const setShowTimeline = (v: boolean) => {
    setShowTimelineState(v);
    try { localStorage.setItem(TIMELINE_KEY, v ? 'open' : 'closed'); } catch { /* private mode */ }
  };
  const [showDoc, setShowDoc] = useState(false);
  const [showDoneWhen, setShowDoneWhen] = useState(false);
  const [showFilesNarrow, setShowFilesNarrow] = useState(false);
  const [showRunsNarrow, setShowRunsNarrow] = useState(false);
  const [showSchedulesNarrow, setShowSchedulesNarrow] = useState(false);
  const [headerErr, setHeaderErr] = useState('');
  const [forking, setForking] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  // The pull request's fate, asked of gh when a run with one is opened.
  // A final answer is remembered on the run by the server; open is re-asked.
  const [prState, setPrState] = useState<{ runId: string; state: 'open' | 'merged' | 'closed' | null } | null>(null);
  const prUrl = selectedRun?.git?.pr;
  useEffect(() => {
    if (!selectedRunId || !prUrl) { setPrState(null); return; }
    if (selectedRun?.git?.prState) { setPrState({ runId: selectedRunId, state: selectedRun.git.prState }); return; }
    let cancelled = false;
    api.prState(selectedRunId).then(async (r) => {
      const d = r.ok ? await r.json() as { state: 'open' | 'merged' | 'closed' | null } : { state: null };
      if (!cancelled) setPrState({ runId: selectedRunId, state: d.state });
    }).catch(() => { if (!cancelled) setPrState({ runId: selectedRunId, state: null }); });
    return () => { cancelled = true; };
  }, [selectedRunId, prUrl, selectedRun?.git?.prState]);
  const forkPlan = async (runId: string) => {
    setHeaderErr('');
    setForking(true);
    try {
      const r = await api.forkPlan(p.id, runId);
      if (!r.ok) { setHeaderErr((await r.json()).error); return; }
      setSelectedRunId(null); // to planning, where the seeded conversation is opening
    } finally { setForking(false); }
  };
  const [composerErr, setComposerErr] = useState('');
  // A start the server refused because the checkout is dirty, kept so the
  // override can retry it without re-uploading the attachments.
  const [dirtyRetry, setDirtyRetry] = useState<{ v: Parameters<typeof startMission>[0] } | null>(null);
  const [starting, setStarting] = useState(false);
  // Planning is what an idle project does, so it opens only when nothing at
  // all is running here — not merely when the run on screen has finished.
  const chat = useChat(liveRuns.length ? null : p.id);
  const wide = useWide(WIDE_PX);
  const deck = useDeck(selectedRunId, isRunning);
  // The project's folder, for the planning screen's rail and the run's Files
  // tab alike. Re-read when the run changes, since a run is what changes it.
  const tree = useProjectTree(p.id, selectedRunId);

  // The "waiting 12m" ages only move if something re-renders; nothing else
  // does while the run is blocked (that is the whole problem). Tick every 30s
  // while an ask is pending, and stop the moment none is.
  const pendingCount = run.approvals.length + run.questions.length;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Also while the run is live: the header's elapsed time is a clock, and a
    // clock that only moves when someone is waiting on an ask is a stopped one.
    if (pendingCount === 0 && !isRunning) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [pendingCount, isRunning]);

  // A new run resets the reading position. The rail tab is in the URL, and
  // a run change writes a URL without the suffix, so it resets by itself.
  useEffect(() => { setFilter(null); }, [selectedRunId]);

  const activity = useMemo(() => (isRunning ? nowActivity(run) : null), [isRunning, run]);
  const doneWhen = useMemo(() => parseDoneWhen(run.missionDoc), [run.missionDoc]);

  const doResume = async (on: Parameters<typeof api.resume>[1] = {}) => {
    if (!selectedRunId) return;
    setHeaderErr('');
    setResuming(true);
    const r = await api.resume(selectedRunId, on).finally(() => setResuming(false));
    if (!r.ok) setHeaderErr((await r.json()).error);
    else refreshFleet();
  };

  const startMission = async (v: {
    mission: string; budget: number; directorModel?: string; workerModel?: string;
    directorProviderId?: string; workerProviderId?: string; browserTools?: boolean;
    /** Crew preset ids the human toggled on. Empty and absent both mean no crew. */
    crew?: string[];
    attachments?: File[];
  }, allowDirty = false) => {
    setComposerErr('');
    setDirtyRetry(null);
    setStarting(true);
    // The composer collected files all along; until now they went nowhere.
    let mission = v.mission;
    try { mission = await withAttachments(p.id, v.mission, v.attachments ?? []); }
    catch (e) { setComposerErr((e as Error).message); setStarting(false); return; }
    const r = await api
      .run(p.id, mission, v.budget, {
        directorModel: v.directorModel, workerModel: v.workerModel,
        directorProviderId: v.directorProviderId, workerProviderId: v.workerProviderId,
        browserTools: v.browserTools, crew: v.crew,
        allowDirty: allowDirty || undefined,
      })
      .finally(() => setStarting(false));
    if (r.ok) { refreshFleet(); return; }
    const body = await r.json().catch(() => ({} as { error?: string; code?: string; files?: string[] }));
    // Every refusal reads the same way, in the server's own words, under the
    // composer — including the 409 for a project already at its mission limit,
    // which names the limit. A race (two tabs, or a schedule firing between
    // the button and the request) is exactly when that sentence is needed.
    setComposerErr(body.error ?? 'could not start');
    // The uncommitted work is the human's, so the refusal is theirs to
    // overrule — retried with the mission text the attachments already
    // produced, so nothing is uploaded twice.
    if (body.code === 'dirty-checkout') {
      setComposerErr(`${body.error}${body.files?.length ? ` (${body.files.join(', ')})` : ''}`);
      setDirtyRetry({ v: { ...v, mission, attachments: [] } });
    }
  };

  const idle = liveRuns.length === 0 && selectedRunId === null;
  // Nothing on screen, and the project can take another mission although one
  // is already running: the composer stands in for the idle screen. Without
  // this the second worktree mission had nowhere to be written — every
  // compose surface lived on the screen that only exists when nothing runs.
  // The planning chat deliberately does not come along: the server refuses to
  // plan while a mission is running, so offering it here would be a dead end.
  const composingSpare = selectedRunId === null && liveRuns.length > 0 && spareCapacity;
  // The reviewers whose PASS still stands on this run, if any.
  const reviewers = reviewedByNames(selectedRun);

  const canResume = !viewingLive && selectedRunId
    && (selectedRun?.status === 'interrupted' || selectedRun?.status === 'error')
    && selectedRun?.directorSessionId;

  // The pill yields below the wide breakpoint so the header stays one row;
  // the rail's Run block carries the same two names in full.
  const modelsPill = wide && selectedRun && (selectedRun.directorModel || selectedRun.workerModel) ? (
    <span title={`director: ${selectedRun.directorModel || 'default'} · workers: ${selectedRun.workerModel || 'default'}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
        borderRadius: 'var(--r-pill)', border: '1px solid var(--line)', background: 'var(--bg-inset)',
        fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--ink-1)',
        maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
      <Icon name="model" size={11} />
      {selectedRun.directorModel || 'default'} · {selectedRun.workerModel || 'default'}
    </span>
  ) : null;

  // Who started this run. A scheduled mission had nobody watching it begin,
  // and that is the first thing to know when reading it back — named where a
  // schedule still exists, plain "scheduled" once it has been deleted.
  const scheduleName = selectedRun?.scheduleId
    ? schedules.schedules.find((s) => s.id === selectedRun.scheduleId)?.name
    : undefined;
  const startedByPill = selectedRun?.scheduleId ? (
    <span title={scheduleName
      ? `Started by the schedule "${scheduleName}" — nobody pressed anything`
      : 'Started by a schedule that has since been deleted'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
        borderRadius: 'var(--r-pill)', border: '1px solid var(--line)', background: 'var(--bg-inset)',
        fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--ink-1)',
        maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
      <Icon name="timeline" size={11} />
      {scheduleName ? `scheduled · ${scheduleName}` : 'scheduled'}
    </span>
  ) : null;

  // The run's identity, first thing in the rail: what am I looking at.
  const runHead = selectedRun && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--ink-0)', lineHeight: 'var(--lh)' }}
        title={selectedRun.mission}>
        {selectedRun.title || selectedRun.mission.split('\n').find((l) => l.trim()) || 'Untitled run'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap' }}>
        <span>{new Date(selectedRun.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <StatusBadge status={viewingLive ? run.runStatus : selectedRun.status} />
        {!viewingLive && <span>read-only</span>}
      </div>
    </div>
  );
  const runsPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {history.length === 0 && <Empty>No runs yet.</Empty>}
      {history.map((r) => (
        <RunRow key={r.id} mission={r.mission} title={r.title} createdAt={r.createdAt}
          costUsd={r.costUsd} costBasis={basisOf(r)} usage={r.usage} status={r.status}
          selected={r.id === selectedRunId} current={liveIds.has(r.id)}
          onSelect={r.id === selectedRunId ? undefined : () => setSelectedRunId(r.id)} />
      ))}
    </div>
  );
  // What runs here without anyone watching. First in the rail because it is
  // the only block with controls on it: buried under a long memory file it
  // would need a scroll before a paused schedule could be resumed.
  const schedulesPane = (
    <SchedulesPanel schedules={schedules.schedules} monthSpendUsd={schedules.monthSpendUsd}
      monthlyCapUsd={schedules.monthlyCapUsd} loading={schedules.loading} error={schedules.error}
      projectId={p.id}
      onNew={() => setScheduleSheet('new')}
      onEdit={(s) => setScheduleSheet(s as Schedule)}
      onPause={(s) => scheduleSaid(api.pauseSchedule(s.id))}
      onResume={(s) => scheduleSaid(api.resumeSchedule(s.id))}
      onRunNow={async (s) => {
        const said = await scheduleSaid(api.runScheduleNow(s.id));
        if (!said) refreshFleet();
        return said;
      }}
      onDelete={(s) => scheduleSaid(api.deleteSchedule(s.id))} />
  );
  // The rail, shared by the run screen and the planning screen so the two
  // are one place: same edge, same width, same resizer, same Runs list.
  const rail = (top: React.ReactNode, content: React.ReactNode) => (
    <aside style={{
      position: 'relative', borderLeft: '1px solid var(--line)', background: 'var(--bg-panel)',
      minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
    }}>
      <div role="separator" aria-orientation="vertical" aria-label="Resize the rail"
        title="Drag to resize" onPointerDown={startRailDrag}
        style={{ position: 'absolute', left: -4, top: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 2 }} />
      {top && <div style={{ padding: 'var(--sp-2) var(--sp-3) 0', flex: '0 0 auto' }}>{top}</div>}
      <div style={{ minHeight: 0, overflowY: 'auto', padding: 'var(--sp-3)' }}>{content}</div>
    </aside>
  );
  const missionDocPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      {runHead}
      <DoneWhenList doc={run.missionDoc} />
      <Disclosure label="Mission doc" open={showDoc} onToggle={() => setShowDoc(!showDoc)}>
        <PlanBoard doc={run.missionDoc ?? undefined} />
      </Disclosure>
      {memory.text.trim() && (
        <Disclosure label="Project memory" open={showMemory} onToggle={() => setShowMemory(!showMemory)}>
          <div style={{ fontSize: 'var(--fs-sm)' }}><RichText text={memory.text} /></div>
        </Disclosure>
      )}
      <CrewPanel agents={run.agents} filter={filter} onFilter={toggleFilter}
        sessionId={run.directorSessionId}
        details={selectedRun && (
          <RunDetails r={selectedRun} live={viewingLive} liveCost={run.costUsd}
            liveBasis={run.costBasis} liveUsage={run.usage} liveTurns={selectedRun.turns}
            onChanged={refreshFleet} />
        )} />
    </div>
  );
  const filesPane = selectedRunId ? (
    <FilesPanel runId={selectedRunId} deck={deck.deck} loading={deck.loading}
      error={deck.error} missing={deck.missing} services={run.services} tree={tree} />
  ) : null;
  const fileCount = deck.deck ? deck.deck.totals.files + deck.deck.artifacts.length : 0;
  // The rail: one place with tabs. Mission = checklist, doc, crew, run facts;
  // Files = what changed and what was produced. The transcript never hides.
  const railTabs = (
    <Tabs size="sm" value={railTab} onChange={(v) => setRailTab(v as RailTab)} tabs={[
      { value: 'mission', label: 'Mission' },
      { value: 'files', label: 'Files', count: fileCount },
      { value: 'runs', label: 'Runs', count: history.length },
    ]} />
  );

  const transcriptTools = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', flexWrap: 'wrap',
      padding: '6px var(--sp-3) 0', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
    }}>
      {run.agents.length > 1 && (
        <CrewStrip agents={run.agents} filter={filter} onFilter={toggleFilter} />
      )}
      <span style={{ flex: 1 }} />
      {run.entries.length > 0 && (
        <>
          <Button variant="ghost" size="sm" icon="timeline"
            title={showTimeline ? 'Hide the timeline' : 'Show the swimlane timeline — click a tick to jump to its entry'}
            onClick={() => setShowTimeline(!showTimeline)}>
            Timeline
          </Button>
          <Button variant="ghost" size="sm" icon="sort"
            title={order === 'newest'
              ? 'Newest first — click to read oldest first'
              : 'Oldest first — click to read newest first'}
            onClick={() => setOrder(order === 'newest' ? 'oldest' : 'newest')}>
            {order === 'newest' ? 'Newest first' : 'Oldest first'}
          </Button>
        </>
      )}
    </div>
  );

  const transcriptColumn = (
    <div style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {transcriptTools}
      {showTimeline && run.entries.length > 0 && (
        <div style={{ padding: '6px var(--sp-3) 0', flex: '0 0 auto' }}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '8px 10px' }}>
            <RunTimeline agents={run.agents} entries={run.entries} live={isRunning}
              selected={filter} onSelect={toggleFilter} onTick={jumpTo} />
          </div>
        </div>
      )}
      {!wide && (
        <div style={{ padding: '6px var(--sp-3) 0', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Disclosure label={doneWhenLabel(doneWhen)} open={showDoneWhen} onToggle={() => setShowDoneWhen(!showDoneWhen)}>
            {missionDocPane}
          </Disclosure>
          <Disclosure label={`Files · ${fileCount}`} open={showFilesNarrow} onToggle={() => setShowFilesNarrow(!showFilesNarrow)}>
            {filesPane}
          </Disclosure>
          <Disclosure label={`Runs · ${history.length}`} open={showRunsNarrow} onToggle={() => setShowRunsNarrow(!showRunsNarrow)}>
            {runsPane}
          </Disclosure>
        </div>
      )}
      <Transcript run={run} filter={filter} jump={jump} order={order} />
    </div>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <AppHeader mode="project" title={p.name} folder={p.folder} onBack={onBack}
        branch={selectedRun?.git
          ? { name: selectedRun.git.branch, hint: `This mission runs on ${selectedRun.git.branch}, made from ${selectedRun.git.base}${selectedRun.git.commits !== undefined ? ` · ${selectedRun.git.commits} commit${selectedRun.git.commits === 1 ? '' : 's'} ahead` : ''}` }
          : p.git?.repo && p.git.branch ? { name: p.git.branch, dirty: p.git.dirty } : null}
        theme={theme} onToggleTheme={onToggleTheme} onSettings={onSettings} search={search}>
        {headerErr && <Banner tone="error" inline>{headerErr}</Banner>}
        {selectedRunId && (
          // A run blocked on an approval or question is not "running" in any
          // sense the human cares about. The badge must say so — the ask
          // alone, in a side rail, went unseen for twelve minutes once.
          run.runStatus === 'running' && pendingCount > 0
            ? <span title={`Waiting on you: ${run.approvals.length} approval(s), ${run.questions.length} question(s)`}>
                <StatusBadge status="needs-you" />
              </span>
            : <StatusBadge status={run.runStatus} />
        )}
        {/* A run that finished its criteria and stopped at its limit reads
            'done'; this says which, so the meter at 100% is not a puzzle. */}
        {selectedRunId && selectedRun?.status === 'done' && selectedRun?.stopReason === 'budget' && (
          <span title="Every DONE WHEN criterion was verified; the run stopped at its cap rather than finishing under it."
            style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>at the cap</span>
        )}
        {/* Who signed this off. Only on a finished run, and only when every
            required reviewer passed — see `reviewedBy`, which is also what the
            fleet tile's glyph asks. A stale PASS shows nothing. */}
        {selectedRunId && reviewers.length > 0 && (
          <span title={`Reviewed by ${reviewers.join(', ')} — ${reviewers.length === 1 ? 'its' : 'their'} PASS on this run's final diff is what let Foreman record it done`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap',
            }}>
            <Icon name="approval" size={11} color="var(--status-good)" />
            reviewed by {reviewers.join(', ')}
          </span>
        )}
        {selectedRunId && (
          <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} detail
            costBasis={run.costBasis} usage={run.usage} turns={selectedRun?.turns}
            elapsedMs={selectedRun?.createdAt
              ? (isRunning ? now : (selectedRun.endedAt ?? now)) - selectedRun.createdAt
              : undefined} />
        )}
        {startedByPill}
        {modelsPill}
        {isRunning && (
          <Button variant="danger" onClick={() => void api.interrupt(selectedRunId!)}>Interrupt</Button>
        )}
        {canResume && (
          <ResumeMenu director={selectedRun?.directorModel} worker={selectedRun?.workerModel}
            budget={selectedRun?.budgetUsd} spent={selectedRun?.costUsd}
            models={models} loading={modelsLoading} note={modelsNote} busy={resuming}
            onResume={(on) => void doResume(on)} />
        )}
        {/* A finished run is a starting point, not a dead end: the planner
            opens with its brief, mission doc and final report already read,
            and drafts a separate mission from there. Not a "continue" — a run
            is one mission, and done stays done. */}
        {!viewingLive && selectedRunId && selectedRun && selectedRun.status !== 'running' && (
          <Button variant="good" icon="write" disabled={forking}
            title="Start a new planning conversation that builds on what this mission did"
            onClick={() => void forkPlan(selectedRunId)}>
            {forking ? 'Opening…' : 'Plan the next step'}
          </Button>
        )}
        {/* The one outward-facing act, behind a button and a sheet: a
            finished mission on its own branch, in a repository with a
            remote. Never from an agent, never from the phone. */}
        {!viewingLive && selectedRunId && selectedRun?.git && selectedRun.status !== 'running' && p.git?.remote && (
          selectedRun.git.pr
            ? <Button icon={prState?.state === 'merged' ? 'check' : prState?.state === 'closed' ? 'close' : 'preview'}
                onClick={() => window.open(selectedRun.git!.pr, '_blank', 'noopener')}
                title={`${selectedRun.git.pr}${prState?.state ? ` · ${prState.state}` : ''}`}>
                Pull request{prState?.runId === selectedRunId && prState.state ? ` · ${prState.state}` : ''} ↗
              </Button>
            /* Once the worktree is removed the checkout this mission worked in
               is gone, so there is nothing left to push from. The button says
               so rather than sending a request the server could only answer
               with a misleading error. */
            : selectedRun.worktree?.removedAt
              ? <Button icon="steer" disabled
                  title="This mission’s worktree has been removed — its checkout is gone, so there is nothing left to push.">
                  Open pull request…
                </Button>
              : <Button icon="steer" onClick={() => setPrOpen(true)} title={`Push ${selectedRun.git.branch} and open a pull request against ${selectedRun.git.base}`}>Open pull request…</Button>
        )}
        {!viewingLive && selectedRunId && (
          <Button variant="primary" onClick={() => setSelectedRunId(null)}>New mission</Button>
        )}
        {/* A live mission on screen, and the project has room for another.
            Clicking lands on the composer rather than merely clearing the
            selection: the human asked to start a mission, and leaving them to
            find the writing surface themselves is how the second worktree
            never gets used. Never shown where the limit is 1. */}
        {viewingLive && spareCapacity && (
          <Button variant="primary" icon="write"
            title={`This project runs each mission in its own git worktree — ${liveRuns.length} of ${missionLimit} running, so there is room for another.`}
            onClick={() => { setSelectedRunId(null); setComposeOpen(true); }}>New mission</Button>
        )}
        {/* At the limit: say so rather than leaving an empty header where the
            button was. Only where the limit is above one — a shared project
            never offered a second mission and must not start explaining. */}
        {viewingLive && !spareCapacity && missionLimit > 1 && (
          <span title="Each mission here runs in its own git worktree, up to this project's limit. One has to finish before another can start."
            style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>
            {liveRuns.length} of {missionLimit} missions running
          </span>
        )}
        {/* The same button on the planning screen: someone arriving with a
            spec written sees the way in before they read anything. */}
        {/* The planning screen's own way in, so it appears only where that
            screen is: nothing running here, nothing selected. */}
        {liveRuns.length === 0 && !selectedRunId && !composeOpen && (
          <Button variant="primary" icon="write" onClick={() => setComposeOpen(true)}
            title="Skip the talk: describe the mission and start it">New mission</Button>
        )}
      </AppHeader>

      {prOpen && selectedRunId && (
        <PullRequestSheet runId={selectedRunId} onClose={() => setPrOpen(false)}
          onDone={() => refreshFleet()} />
      )}

      {scheduleSheet && (
        <ScheduleSheet schedule={scheduleSheet === 'new' ? null : scheduleSheet}
          models={models} modelsLoading={modelsLoading} modelsNote={modelsNote}
          modelsInheritNote={modelsInheritNote} defaultBudgetUsd={p.defaultBudgetUsd}
          onClose={() => setScheduleSheet(null)}
          onPreview={async (cadence) => {
            const r = await api.previewCadence(cadence as Cadence).catch(() => null);
            if (!r) return { error: 'could not reach the server' };
            const body = await r.json().catch(() => ({})) as { next?: number[]; error?: string };
            return r.ok ? { next: body.next ?? [] } : { error: body.error ?? `HTTP ${r.status}` };
          }}
          onSave={(input) => scheduleSaid(scheduleSheet === 'new'
            ? api.createSchedule(p.id, input as ScheduleInput)
            : api.updateSchedule(scheduleSheet.id, input as ScheduleInput))} />
      )}

      {/* Nothing sits between the header and the asks. The read-only banner
          follows the strip: a past run has no asks, so the order only
          matters when it does not apply. */}
      {selectedRunId && (
        <NowStrip approvals={run.approvals} questions={run.questions} now={now}
          running={isRunning} activity={activity}
          onAllow={(id) => void api.permission(id, 'allow')}
          onAlways={(id) => void api.permission(id, 'allow_always')}
          onDeny={(id) => void api.permission(id, 'deny')}
          onAnswer={(id, answer) => void api.answer(id, answer)} />
      )}
      {/* Nothing here can run until this is fixed, so it is said on the page,
          not left to the first failed turn. Per project: another project may
          have a provider of its own that is fine. */}
      {(p.billingMode ?? auth.mode) === 'none' && (
        <Banner tone="caution">
          This project has nothing to run on: Claude Code is not signed in on this machine. Sign in and restart Foreman,
          or give the project a provider of its own.
          <Button variant="ghost" size="sm" icon="provider" style={{ marginLeft: 'var(--sp-2)' }} onClick={() => onSettings('provider')}>Settings → Provider</Button>
        </Banner>
      )}
      {/* Stopped at a cap: the one thing the reader wants is to raise it and
          go on, so that is the banner — a click, not a trip through a menu.
          Turn, time and token caps reset on resume by themselves. */}
      {canResume && selectedRun?.stopReason === 'budget' && (
        <Banner tone="caution">
          This run stopped at its ${selectedRun.budgetUsd.toFixed(2)} cap with ${selectedRun.costUsd.toFixed(2)} spent. Raise the cap and continue:
          {[5, 10].map((n) => (
            <Button key={n} variant="good" size="sm" icon="resume" disabled={resuming} style={{ marginLeft: 'var(--sp-2)' }}
              onClick={() => void doResume({ budgetUsd: Math.round((selectedRun.budgetUsd + n) * 100) / 100 })}>+${n} & resume</Button>
          ))}
          <Button variant="good" size="sm" icon="resume" disabled={resuming} style={{ marginLeft: 'var(--sp-2)' }}
            onClick={() => void doResume({ budgetUsd: Math.round(selectedRun.budgetUsd * 2 * 100) / 100 })}>Double & resume</Button>
        </Banner>
      )}
      {canResume && selectedRun?.stopReason && selectedRun.stopReason !== 'budget' && (
        <Banner tone="caution">
          This run stopped at its {selectedRun.stopReason === 'turns' ? 'turn' : selectedRun.stopReason === 'time' ? 'time' : 'token'} cap. Resume continues it with a fresh allowance.
        </Banner>
      )}
      {selectedRunId && <LeftoverServices runId={selectedRunId} services={leftovers.list} onDone={leftovers.refresh} />}
      {heldBranch && (
        <Banner tone="caution">
          This checkout is held by the running mission, on{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>{heldBranch}</span>. Commits you make in the
          folder land on that branch, and anything left uncommitted joins the mission's closing commit.
        </Banner>
      )}
      {selectedRunId && !viewingLive && (
        <Banner tone="readonly">
          Viewing a past run (read-only).
          {/* The way back, where the reader is when they want it. The header's
              "New mission" says what it starts, not where it goes. */}
          <Button variant="ghost" size="sm" icon="back" style={{ marginLeft: 'var(--sp-2)' }}
            onClick={() => setSelectedRunId(newestLiveId)}>
            {newestLiveId ? `Back to the live run${liveRuns.length > 1 ? ' (the newest)' : ''}` : 'Back to planning'}
          </Button>
        </Banner>
      )}


      {idle || composingSpare ? (
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: wide ? 'grid' : 'flex', flexDirection: 'column', gridTemplateColumns: wide ? `minmax(0, 1fr) ${railWidth}px` : undefined }}>
        <div style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Narrow: the rail is gone, so the runs — and the schedules, which
              are the only way to resume a paused one — fold into the top of
              the conversation instead of being unreachable on a phone. */}
          {!wide && (
            <div style={{ padding: '6px var(--sp-3) 0', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Disclosure label={`Schedules · ${schedules.schedules.length}`} open={showSchedulesNarrow} onToggle={() => setShowSchedulesNarrow(!showSchedulesNarrow)}>
                {schedulesPane}
              </Disclosure>
              {history.length > 0 && (
                <Disclosure label={`Runs · ${history.length}`} open={showRunsNarrow} onToggle={() => setShowRunsNarrow(!showRunsNarrow)}>
                  {runsPane}
                </Disclosure>
              )}
            </div>
          )}
          {composeOpen || composingSpare ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: 'var(--sp-2) var(--sp-3) 0', flex: '0 0 auto' }}>
                {/* With a mission already running there is no conversation to
                    go back to — the way back is the mission being left. */}
                {composingSpare ? (
                  <Button variant="ghost" size="sm" icon="back" onClick={() => setSelectedRunId(newestLiveId)}>
                    Back to the live mission{liveRuns.length > 1 ? ' (the newest)' : ''}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" icon="back" onClick={() => setComposeOpen(false)}>
                    Back to the conversation
                  </Button>
                )}
              </div>
              {/* margin:auto centers the card vertically yet degrades to normal
                  flow (scrollable) when the composer is taller than the view. */}
              <div style={{ margin: 'auto', width: '100%', padding: 'var(--sp-4) 0 var(--sp-5)' }}>
                <Composer folder={p.folder} defaultBudgetUsd={p.defaultBudgetUsd}
                  error={composerErr}
                  errorAction={dirtyRetry ? { label: 'Start anyway', onClick: () => void startMission(dirtyRetry.v, true) } : undefined}
                  busy={starting} models={models}
                  modelsLoading={modelsLoading} modelsNote={modelsNote}
                  modelsInheritNote={modelsInheritNote}
                  crewPresets={crewPresets} crew={crew} onCrewChange={rememberCrew}
                  onStart={(v) => void startMission(v)}
                  style={{
                    background: 'var(--bg-panel)', border: '1px solid var(--line)',
                    borderRadius: 'var(--r-md)', padding: 'var(--sp-5)',
                    margin: '0 auto', boxSizing: 'border-box',
                  }} />
                {/* Who pays and which install, at the moment of commitment. The
                    composer is a DS component with no footer slot, and this
                    reflects project state rather than composer state, so it lives
                    in the view beside it. */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap',
                  margin: 'var(--sp-3) auto 0', maxWidth: 'var(--composer-max)',
                  fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
                }}>
                  <BillingBadge mode={p.billingMode ?? auth.mode} compact account={auth.account}
                    source={billingSource(p, auth.source)} />
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    runs on {providerHome(p.provider) ?? 'the server default instance'}
                  </span>
                  {p.git?.repo && (
                    <span title={branchPerMission ? 'Foreman creates the branch from what is checked out, commits the mission\'s work on it at the end, and never merges or pushes. Settings → Projects turns this off.' : 'The mission edits the current branch. Settings → Projects can give each mission a branch of its own.'}>
                      · {branchPerMission ? <>on its own branch from <span style={{ fontFamily: 'var(--font-mono)' }}>{p.git.branch}</span></> : <>on <span style={{ fontFamily: 'var(--font-mono)' }}>{p.git.branch}</span> directly</>}
                    </span>
                  )}
                  {/* What else is running here, at the moment of commitment —
                      a project that can hold several missions at once should
                      not make anyone count them. Silent where the limit is 1,
                      which is every shared project. */}
                  {missionLimit > 1 && (
                    <span title="Each mission here runs in a git worktree of its own, so several can run at the same time up to this project's limit.">
                      · {liveRuns.length} of {missionLimit} missions running
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              <PlanPane chat={chat} folder={p.folder} starting={starting} error={composerErr}
                errorAction={dirtyRetry ? { label: 'Start anyway', onClick: () => void startMission(dirtyRetry.v, true) } : undefined}
                models={models} modelsLoading={modelsLoading}
                modelsNote={modelsNote} modelsInheritNote={modelsInheritNote}
                crewPresets={crewPresets} crew={crew} onCrewChange={rememberCrew}
                onStart={(v) => void startMission(v)}
                onCompose={() => setComposeOpen(true)} hasRuns={history.length > 0}
                recent={history} runsOn={runsOnLine} onOpenRun={(id) => setSelectedRunId(id)} onForkRun={(id) => void forkPlan(id)} forking={forking}
                projectId={p.id} onSettings={onSettings} />
            </>
          )}
        </div>
        {/* Planning is the run screen's idle state, so it keeps the rail: the
            runs are right there, and a past run is one click from the talk
            about the next one. */}
        {wide && rail(
          null,
          // The folder as it stands. Every run here shares it, so it belongs
          // to the project screen, not to any one run's deck.
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
            {schedulesPane}
            <MemoryPanel memory={memory} />
            <FolderBrowser key={p.id} files={tree.files} truncated={tree.truncated} loading={tree.loading}
              error={tree.error} onRefresh={tree.refresh} urlBase={`/projects/${encodeURIComponent(p.id)}`} />
          </div>,
        )}
        </div>
      ) : (
        <main style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {wide ? (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${railWidth}px` }}>
              {transcriptColumn}
              {rail(railTabs, railTab === 'mission' ? missionDocPane : railTab === 'files' ? filesPane : runsPane)}
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {transcriptColumn}
            </div>
          )}
          {viewingLive && (
            <div style={{ padding: 'var(--sp-2) var(--sp-3) var(--sp-3)', flex: '0 0 auto' }}>
              <SteerBar
                agents={[{ id: 'director', status: run.runStatus === 'running' ? 'running' : 'done' }]}
                to="director" onTo={() => {}}
                timing="next" onTiming={() => {}}
                disabled={run.runStatus !== 'running'}
                disabledReason="Run finished — start a new mission."
                onSend={(text) => void api.steer(selectedRunId!, text)} />
            </div>
          )}
        </main>
      )}
    </div>
  );
}
