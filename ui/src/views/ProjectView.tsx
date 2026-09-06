import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  api, basisOf, providerHome, useChat, useRunHistory, useRunView,
  type CostBasis, type Entry, type ProjectSummary, type RunSummary,
  type RunView as RunViewState, type TokenUsage, withAttachments,
} from '../state';
import { useDeck } from '../deck';
import { AppHeader } from '../ds/shell/AppHeader';
import { Button } from '../ds/core/Button';
import { Empty } from '../ds/core/Empty';
import { Icon } from '../ds/core/Icon';
import { Banner } from '../ds/status/Banner';
import { StatusBadge } from '../ds/status/StatusBadge';
import { BillingBadge, type BillingMode } from '../ds/status/BillingBadge';
import { BudgetMeter, formatTokens } from '../ds/status/BudgetMeter';
import { RunTimeline } from '../ds/mission/RunTimeline';
import { TranscriptEntry } from '../ds/mission/TranscriptEntry';
import { PlanBoard } from '../ds/mission/PlanBoard';
import { Composer } from '../ds/mission/Composer';
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
import { SettingsGlance } from '../ds/settings/SettingsGlance';
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
            kind={e.kind} body={e.body} ts={e.ts} to={e.to} timing={e.timing} />
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
function PlanPane({
  chat, folder, starting, error, models, modelsLoading, modelsNote, modelsInheritNote, onStart, onCompose, hasRuns, projectId, onSettings,
  recent = [], onOpenRun, onForkRun, forking = false,
}: {
  /** The project's latest runs, newest first, for the empty state's "pick up where you left off". */
  recent?: RunSummary[];
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
    attachments?: File[];
  }) => void;
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
              {recent.slice(0, 4).map((r, i) => {
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
            Planning reads the project and never changes it — a mission does that.
          </span>
          <button type="button" onClick={onCompose} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', width: '100%', boxSizing: 'border-box',
            background: 'none', border: '1px dashed var(--line-strong)', borderRadius: 'var(--r-sm)',
            cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textAlign: 'left',
          }}>
            <Icon name="write" size={12} />
            Or skip the talk: describe the mission and start it
            <Icon name="chevronRight" size={12} style={{ marginLeft: 'auto' }} />
          </button>
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
            models={models} modelsLoading={modelsLoading}
            modelsNote={modelsNote} modelsInheritNote={modelsInheritNote}
            busy={starting} error={error}
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
  theme: 'dark' | 'light'; onToggleTheme: () => void; onSettings: () => void;
  /** Saved settings, for the rail's glance: global and this project's overlay. */
  settings: { global: Settings; project?: Settings };
}) {
  const history = useRunHistory(p.id);
  const effectiveSettings = { ...DEFAULT_SETTINGS, ...settings.global, ...(settings.project ?? {}) } as Settings;
  const settingOverrides = Object.keys(settings.project ?? {});
  const settingsGlance = (
    <SettingsGlance effective={effectiveSettings} overrides={settingOverrides} onOpen={onSettings} />
  );
  const activeRunId = p.activeRun?.id ?? null;
  // The selected run lives in the URL so a refresh restores the same view.
  const selectedRunId = routeRunId;
  const setSelectedRunId = onSelectRun;
  useEffect(() => {
    if (activeRunId) onSelectRun(activeRunId);
    // Snap to the active run only when it starts/changes, so history
    // browsing during a live mission is not fought over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId]);

  const viewingLive = selectedRunId !== null && selectedRunId === activeRunId;
  const run = useRunView(selectedRunId, viewingLive);
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
  const [headerErr, setHeaderErr] = useState('');
  const [forking, setForking] = useState(false);
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
  const [starting, setStarting] = useState(false);
  const chat = useChat(activeRunId ? null : p.id);
  // Idle projects open on the conversation: the composer asks for a
  // well-specified brief at the moment you know least, which is the wrong
  // order. Writing one directly stays one click away, folded under the chat.
  const [composeOpen, setComposeOpen] = useState(false);
  const wide = useWide(WIDE_PX);
  const deck = useDeck(selectedRunId, isRunning);

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
    attachments?: File[];
  }) => {
    setComposerErr('');
    setStarting(true);
    // The composer collected files all along; until now they went nowhere.
    let mission = v.mission;
    try { mission = await withAttachments(p.id, v.mission, v.attachments ?? []); }
    catch (e) { setComposerErr((e as Error).message); setStarting(false); return; }
    const r = await api
      .run(p.id, mission, v.budget, {
        directorModel: v.directorModel, workerModel: v.workerModel,
        directorProviderId: v.directorProviderId, workerProviderId: v.workerProviderId,
        browserTools: v.browserTools,
      })
      .finally(() => setStarting(false));
    if (!r.ok) setComposerErr((await r.json()).error);
    else refreshFleet();
  };

  const idle = !activeRunId && selectedRunId === null;
  const canResume = !activeRunId && selectedRunId
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
          selected={r.id === selectedRunId} current={r.id === activeRunId}
          onSelect={r.id === selectedRunId ? undefined : () => setSelectedRunId(r.id)} />
      ))}
    </div>
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
      <CrewPanel agents={run.agents} filter={filter} onFilter={toggleFilter}
        sessionId={run.directorSessionId}
        details={selectedRun && (
          <RunDetails r={selectedRun} live={viewingLive} liveCost={run.costUsd}
            liveBasis={run.costBasis} liveUsage={run.usage} liveTurns={selectedRun.turns}
            onChanged={refreshFleet} />
        )} />
      {settingsGlance}
    </div>
  );
  const filesPane = selectedRunId ? (
    <FilesPanel runId={selectedRunId} deck={deck.deck} loading={deck.loading}
      error={deck.error} missing={deck.missing} services={run.services} />
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
        {selectedRunId && (
          <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} detail
            costBasis={run.costBasis} usage={run.usage} turns={selectedRun?.turns}
            elapsedMs={selectedRun?.createdAt
              ? (isRunning ? now : (selectedRun.endedAt ?? now)) - selectedRun.createdAt
              : undefined} />
        )}
        {modelsPill}
        {isRunning && (
          <Button variant="danger" onClick={() => void api.interrupt(selectedRunId!)}>Interrupt</Button>
        )}
        {canResume && (
          <ResumeMenu director={selectedRun?.directorModel} worker={selectedRun?.workerModel}
            models={models} loading={modelsLoading} note={modelsNote} busy={resuming}
            onResume={(on) => void doResume(on)} />
        )}
        {/* A finished run is a starting point, not a dead end: the planner
            opens with its brief, mission doc and final report already read,
            and drafts a separate mission from there. Not a "continue" — a run
            is one mission, and done stays done. */}
        {!activeRunId && selectedRunId && selectedRun && selectedRun.status !== 'running' && (
          <Button variant="good" icon="write" disabled={forking}
            title="Start a new planning conversation that builds on what this mission did"
            onClick={() => void forkPlan(selectedRunId)}>
            {forking ? 'Opening…' : 'Plan the next step'}
          </Button>
        )}
        {!activeRunId && selectedRunId && (
          <Button variant="primary" onClick={() => setSelectedRunId(null)}>New mission</Button>
        )}
      </AppHeader>

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
      {selectedRunId && !viewingLive && (
        <Banner tone="readonly">
          Viewing a past run (read-only).
          {/* The way back, where the reader is when they want it. The header's
              "New mission" says what it starts, not where it goes. */}
          <Button variant="ghost" size="sm" icon="back" style={{ marginLeft: 'var(--sp-2)' }}
            onClick={() => setSelectedRunId(activeRunId ?? null)}>
            {activeRunId ? 'Back to the live run' : 'Back to planning'}
          </Button>
        </Banner>
      )}


      {idle ? (
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: wide ? 'grid' : 'flex', flexDirection: 'column', gridTemplateColumns: wide ? `minmax(0, 1fr) ${railWidth}px` : undefined }}>
        <div style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Narrow: the runs fold into the top of the conversation. */}
          {!wide && history.length > 0 && (
            <div style={{ padding: '6px var(--sp-3) 0', flex: '0 0 auto' }}>
              <Disclosure label={`Runs · ${history.length}`} open={showRunsNarrow} onToggle={() => setShowRunsNarrow(!showRunsNarrow)}>
                {runsPane}
              </Disclosure>
            </div>
          )}
          {composeOpen ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: 'var(--sp-2) var(--sp-3) 0', flex: '0 0 auto' }}>
                <Button variant="ghost" size="sm" icon="back" onClick={() => setComposeOpen(false)}>
                  Back to the conversation
                </Button>
              </div>
              {/* margin:auto centers the card vertically yet degrades to normal
                  flow (scrollable) when the composer is taller than the view. */}
              <div style={{ margin: 'auto', width: '100%', padding: 'var(--sp-4) 0 var(--sp-5)' }}>
                <Composer folder={p.folder} defaultBudgetUsd={p.defaultBudgetUsd}
                  error={composerErr} busy={starting} models={models}
                  modelsLoading={modelsLoading} modelsNote={modelsNote}
                  modelsInheritNote={modelsInheritNote}
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
                </div>
              </div>
            </div>
          ) : (
            <>
              <PlanPane chat={chat} folder={p.folder} starting={starting} error={composerErr}
                models={models} modelsLoading={modelsLoading}
                modelsNote={modelsNote} modelsInheritNote={modelsInheritNote}
                onStart={(v) => void startMission(v)}
                onCompose={() => setComposeOpen(true)} hasRuns={history.length > 0}
                recent={history} onOpenRun={(id) => setSelectedRunId(id)} onForkRun={(id) => void forkPlan(id)} forking={forking}
                projectId={p.id} onSettings={onSettings} />
            </>
          )}
        </div>
        {/* Planning is the run screen's idle state, so it keeps the rail: the
            runs are right there, and a past run is one click from the talk
            about the next one. */}
        {wide && rail(
          null,
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
            {settingsGlance}
            <section>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)', padding: '0 0 6px' }}>
                Runs · {history.length}
              </div>
              {history.length > 0 ? runsPane : <Empty>No runs yet — the first mission you start here will be the first.</Empty>}
            </section>
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
