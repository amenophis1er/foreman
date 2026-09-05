import React, { useEffect, useRef, useState } from 'react';
import {
  api, basisOf, providerHome, useChat, useRunHistory, useRunView,
  type CostBasis, type ProjectSummary, type RunSummary,
  type RunView as RunViewState, type TokenUsage,
} from '../state';
import { AppHeader } from '../ds/shell/AppHeader';
import { Button } from '../ds/core/Button';
import { Empty } from '../ds/core/Empty';
import { SectionTitle } from '../ds/core/SectionTitle';
import { Banner } from '../ds/status/Banner';
import { StatusBadge } from '../ds/status/StatusBadge';
import { BillingBadge, type BillingMode } from '../ds/status/BillingBadge';
import { BudgetMeter, formatTokens } from '../ds/status/BudgetMeter';
import { AttentionBar } from '../ds/status/AttentionBar';
import { RunRail } from '../ds/mission/RunRail';
import { RunTimeline } from '../ds/mission/RunTimeline';
import { TranscriptEntry } from '../ds/mission/TranscriptEntry';
import { ApprovalCard } from '../ds/mission/ApprovalCard';
import { QuestionCard } from '../ds/mission/QuestionCard';
import { PlanBoard } from '../ds/mission/PlanBoard';
import { Composer } from '../ds/mission/Composer';
import { ChatBar } from '../ds/mission/ChatBar';
import { QuestionPicker } from '../ds/mission/QuestionPicker';
import { ProposalCard } from '../ds/mission/ProposalCard';
import { Tabs } from '../ds/core/Tabs';
import { SteerBar } from '../ds/mission/SteerBar';
import type { ModelInfo } from '../ds/forms/ModelSelect';

/**
 * Where this project's spend actually lands. A pinned provider names itself;
 * anything else is the server's own credential, and saying so is the point —
 * this line sits wherever money is about to be committed.
 */
/** "12m", "3h", "45s" — how long a pending ask has been on the human's desk. */
function fmtAge(since: number | undefined, now: number): string {
  if (!since) return '';
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A pending ask's age line, rendered above its card so the wait is legible without reading the card. */
function WaitingSince({ since, now }: { since?: number; now: number }) {
  const age = fmtAge(since, now);
  if (!age) return null;
  return (
    <div style={{
      fontSize: 'var(--fs-xs)', color: 'var(--status-warning)',
      fontWeight: 'var(--fw-semibold)', marginBottom: 4,
    }}>waiting {age}</div>
  );
}

function billingSource(p: ProjectSummary, serverSource: string): string {
  const home = providerHome(p.provider);
  if (!p.provider || !home) return serverSource;
  if (p.provider.kind === 'claude-code') {
    return p.provider.ownLogin ? `${home} (this project's own login)` : home;
  }
  return `${p.provider.kind} · ${home}`;
}

export type TranscriptOrder = 'newest' | 'oldest';

const ORDER_KEY = 'foreman.transcriptOrder';

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
      {header}
      {shown.length === 0 && <Empty>Transcript will appear here.</Empty>}
      {shown.map((e) => (
        <div key={e.id} id={`entry-${e.id}`} style={{
          scrollMarginTop: 8, borderRadius: 'var(--r-sm)',
          outline: flashId === e.id ? '2px solid var(--brand)' : 'none',
          transition: 'outline-color var(--dur-fast) var(--ease)',
        }}>
          <TranscriptEntry agent={e.agent} title={e.title}
            kind={e.kind} body={e.body} ts={e.ts} to={e.to} timing={e.timing} />
        </div>
      ))}
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
  chat, folder, starting, error, models, modelsLoading, modelsNote, modelsInheritNote, onStart,
}: {
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
  }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.entries.length, chat.proposal, chat.thinking]);

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
        {chat.entries.length === 0 && !chat.thinking && (
          <div style={{
            margin: 'auto', maxWidth: '34rem', textAlign: 'center',
            display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
          }}>
            <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>
              Talk it through first
            </span>
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', lineHeight: 'var(--lh-prose)' }}>
              The foreman reads <span style={{ fontFamily: 'var(--font-mono)' }}>{folder}</span> and
              thinks it through with you — what you want, what is already there, what could go wrong.
              When the shape is clear it drafts a mission for you to start.
            </span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
              It can read the project. It cannot change it — only a mission does that.
            </span>
          </div>
        )}
        {chat.entries.map((e) => (
          <TranscriptEntry key={e.id} agent={e.agent} title={e.title}
            kind={e.kind} body={e.body} ts={e.ts} />
        ))}
        {chat.proposal && (
          <ProposalCard
            mission={chat.proposal.mission}
            doneWhen={chat.proposal.doneWhen}
            budgetUsd={chat.proposal.budgetUsd}
            rationale={chat.proposal.rationale}
            browser={chat.proposal.browser}
            models={models} modelsLoading={modelsLoading}
            modelsNote={modelsNote} modelsInheritNote={modelsInheritNote}
            busy={starting} error={error}
            onStart={(v) => onStart(v)}
            onDismiss={chat.dismissProposal} />
        )}
      </div>
      <div style={{ padding: 'var(--sp-2) var(--sp-3) var(--sp-3)', flex: '0 0 auto' }}>
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
            onFreeText={(t) => void chat.send(t)} />
        ) : (
          <ChatBar busy={chat.thinking} who={chat.who} onSend={(t) => void chat.send(t)} />
        )}
      </div>
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

export function ProjectView({
  p, models, modelsLoading, modelsNote, modelsInheritNote, routeRunId, onSelectRun, onBack,
  refreshFleet, auth, theme, onToggleTheme, onSettings,
}: {
  p: ProjectSummary; models: ModelInfo[] | null;
  modelsLoading?: boolean; modelsNote?: string; modelsInheritNote?: string;
  auth: { mode: BillingMode; source: string; account?: { email?: string; org?: string } };
  routeRunId: string | null; onSelectRun: (runId: string | null) => void;
  onBack: () => void; refreshFleet: () => void;
  theme: 'dark' | 'light'; onToggleTheme: () => void; onSettings: () => void;
}) {
  const history = useRunHistory(p.id);
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
  const [filter, setFilter] = useState<string | null>(null);
  const [jump, setJump] = useState<{ id: number; n: number } | null>(null);
  const jumpTo = (e: { id?: string | number; agent: string }) => {
    if (typeof e.id !== 'number') return;
    if (filter && filter !== e.agent) setFilter(null); // entry must be visible
    setJump({ id: e.id, n: Date.now() });
  };
  const [resuming, setResuming] = useState(false);
  const [order, setOrder] = useTranscriptOrder();
  const [showTimeline, setShowTimeline] = useState(true);
  const [headerErr, setHeaderErr] = useState('');
  const [composerErr, setComposerErr] = useState('');
  const [starting, setStarting] = useState(false);
  const rightRail = useRef<HTMLDivElement>(null);
  const chat = useChat(activeRunId ? null : p.id);
  // Idle projects open on the conversation: the composer asks for a
  // well-specified brief at the moment you know least, which is the wrong
  // order. Writing one directly stays one click away.
  const [idleMode, setIdleMode] = useState<'plan' | 'compose'>('plan');

  // The "waiting 12m" ages only move if something re-renders; nothing else
  // does while the run is blocked (that is the whole problem). Tick every 30s
  // while an ask is pending, and stop the moment none is.
  const pendingCount = run.approvals.length + run.questions.length;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pendingCount === 0) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [pendingCount]);

  const doResume = async () => {
    if (!selectedRunId) return;
    setHeaderErr('');
    setResuming(true);
    const r = await api.resume(selectedRunId).finally(() => setResuming(false));
    if (!r.ok) setHeaderErr((await r.json()).error);
    else refreshFleet();
  };

  const startMission = async (v: {
    mission: string; budget: number; directorModel?: string; workerModel?: string;
    directorProviderId?: string; workerProviderId?: string; browserTools?: boolean;
  }) => {
    setComposerErr('');
    setStarting(true);
    const r = await api
      .run(p.id, v.mission, v.budget, {
        directorModel: v.directorModel, workerModel: v.workerModel,
        directorProviderId: v.directorProviderId, workerProviderId: v.workerProviderId,
        browserTools: v.browserTools,
      })
      .finally(() => setStarting(false));
    if (!r.ok) setComposerErr((await r.json()).error);
    else refreshFleet();
  };

  const showComposer = !activeRunId && selectedRunId === null;
  const canResume = !activeRunId && selectedRunId
    && (selectedRun?.status === 'interrupted' || selectedRun?.status === 'error')
    && selectedRun?.directorSessionId;

  const railCurrent = selectedRunId ? {
    id: selectedRunId,
    mission: run.mission || selectedRun?.mission || '',
    title: run.title || selectedRun?.title,
    createdAt: selectedRun?.createdAt,
    costUsd: run.costUsd,
    status: run.runStatus,
    live: viewingLive && run.runStatus === 'running',
  } : undefined;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <AppHeader mode="project" title={p.name} folder={p.folder} onBack={onBack}
        theme={theme} onToggleTheme={onToggleTheme} onSettings={onSettings}>
        {headerErr && <Banner tone="error" inline>{headerErr}</Banner>}
        <BillingBadge mode={p.billingMode ?? auth.mode} compact account={auth.account}
          source={billingSource(p, auth.source)} />
        {selectedRunId && (
          // A run blocked on an approval or question is not "running" in any
          // sense the human cares about. The badge must say so — the ask
          // alone, in the right rail, went unseen for twelve minutes once.
          run.runStatus === 'running' && pendingCount > 0
            ? <span title={`Waiting on you: ${run.approvals.length} approval(s), ${run.questions.length} question(s)`}>
                <StatusBadge status="needs-you" />
              </span>
            : <StatusBadge status={run.runStatus} />
        )}
        {selectedRunId && (
          <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} detail
            costBasis={run.costBasis} usage={run.usage} turns={selectedRun?.turns} />
        )}
        {viewingLive && run.runStatus === 'running' && (
          <Button variant="danger" onClick={() => void api.interrupt(selectedRunId!)}>Interrupt</Button>
        )}
        {canResume && (
          <Button variant="good" icon="resume" disabled={resuming}
            title="Restore the director's session and continue this mission"
            onClick={() => void doResume()}>
            {resuming ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {!activeRunId && selectedRunId && (
          <Button variant="primary" onClick={() => setSelectedRunId(null)}>New mission</Button>
        )}
      </AppHeader>

      {selectedRunId && !viewingLive && (
        <Banner tone="readonly">Viewing a past run (read-only).</Banner>
      )}

      {showComposer ? (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--rail-left) 1fr' }}>
          <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-panel)', overflowY: 'auto', padding: 'var(--sp-3)' }}>
            <RunRail history={history} onSelectRun={setSelectedRunId} />
          </div>
          <div style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flex: '0 0 auto',
              padding: 'var(--sp-2) var(--sp-3)', borderBottom: '1px solid var(--line)',
            }}>
              <Tabs size="sm" value={idleMode} onChange={(v) => setIdleMode(v as 'plan' | 'compose')}
                tabs={[
                  { value: 'plan', label: 'Plan', icon: 'steer' },
                  { value: 'compose', label: 'Write a mission', icon: 'write' },
                ]} />
              <span style={{ flex: 1 }} />
              {idleMode === 'plan' && chat.costUsd > 0 && (
                <span title="What this conversation has cost so far. Planning is not charged to any mission budget."
                  style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>
                  conversation ${chat.costUsd.toFixed(3)}
                </span>
              )}
              {idleMode === 'plan' && chat.entries.length > 0 && (
                <Button variant="ghost" size="sm" icon="close" disabled={chat.thinking}
                  title="Forget this conversation and start a new one"
                  onClick={() => void chat.clear()}>Clear</Button>
              )}
            </div>

            {idleMode === 'plan' ? (
              <PlanPane chat={chat} folder={p.folder} starting={starting} error={composerErr}
                models={models} modelsLoading={modelsLoading}
                modelsNote={modelsNote} modelsInheritNote={modelsInheritNote}
                onStart={(v) => void startMission(v)} />
            ) : (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {/* margin:auto centers the card vertically yet degrades to normal
                flow (scrollable) when the composer is taller than the view. */}
            <div style={{ margin: 'auto', width: '100%', padding: 'var(--sp-5) 0' }}>
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
            )}
          </div>
        </div>
      ) : (
        <main style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--rail-left) 1fr var(--rail-right)' }}>
          <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-panel)', minHeight: 0, minWidth: 0, overflow: 'hidden auto', padding: 'var(--sp-3)' }}>
            <RunRail current={railCurrent} agents={run.agents} history={history}
              selectedRunId={selectedRunId ?? undefined}
              filter={filter} onFilter={(a) => setFilter(filter === a ? null : a)}
              onSelectRun={setSelectedRunId}
              sessionId={run.directorSessionId}
              details={selectedRun && (
                <RunDetails r={selectedRun} live={viewingLive} liveCost={run.costUsd}
                  liveBasis={run.costBasis} liveUsage={run.usage} liveTurns={selectedRun.turns}
                  onChanged={refreshFleet} />
              )} />
          </div>
          <div style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {(run.entries.length > 0 || run.approvals.length + run.questions.length > 0) && (
              <div style={{
                padding: 'var(--sp-3)', borderBottom: '1px solid var(--line)',
                display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
                flex: '0 0 auto',
              }}>
                <AttentionBar approvals={run.approvals.length} questions={run.questions.length}
                  onReview={() => rightRail.current?.scrollIntoView({ behavior: 'smooth' })} />
                {run.entries.length > 0 && (
                  <div style={{
                    background: 'var(--bg-panel)', border: '1px solid var(--line)',
                    borderRadius: 'var(--r-sm)', padding: '8px 10px',
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      marginBottom: showTimeline ? 8 : 0, fontSize: 'var(--fs-xs)',
                      color: 'var(--ink-2)', textTransform: 'uppercase',
                      letterSpacing: 'var(--ls-caps)',
                    }}>
                      Timeline<span style={{ flex: 1 }} />
                      <Button variant="ghost" size="sm"
                        icon={showTimeline ? 'chevronDown' : 'chevronRight'}
                        onClick={() => setShowTimeline(!showTimeline)}>
                        {showTimeline ? 'Hide' : 'Show'}
                      </Button>
                    </div>
                    {showTimeline && (
                      <RunTimeline agents={run.agents} entries={run.entries}
                        live={viewingLive && run.runStatus === 'running'}
                        selected={filter}
                        onSelect={(a) => setFilter(filter === a ? null : a)}
                        onTick={jumpTo} />
                    )}
                  </div>
                )}
              </div>
            )}
            {run.entries.length > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
                padding: '8px var(--sp-3) 0', fontSize: 'var(--fs-xs)',
                color: 'var(--ink-2)', textTransform: 'uppercase',
                letterSpacing: 'var(--ls-caps)',
              }}>
                Transcript<span style={{ flex: 1 }} />
                <Button variant="ghost" size="sm" icon="sort"
                  title={order === 'newest'
                    ? 'Newest first — click to read oldest first'
                    : 'Oldest first — click to read newest first'}
                  onClick={() => setOrder(order === 'newest' ? 'oldest' : 'newest')}>
                  {order === 'newest' ? 'Newest first' : 'Oldest first'}
                </Button>
              </div>
            )}
            <Transcript run={run} filter={filter} jump={jump} order={order} />
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
          </div>
          <div ref={rightRail} style={{
            borderLeft: '1px solid var(--line)', background: 'var(--bg-panel)',
            minHeight: 0, minWidth: 0, overflow: 'hidden auto', padding: 'var(--sp-3)',
            display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)',
          }}>
            <section>
              <SectionTitle>Approvals</SectionTitle>
              {run.approvals.length === 0 && <Empty>No pending approvals.</Empty>}
              {run.approvals.map((a) => (
                <div key={a.id} style={{ marginBottom: 'var(--sp-2)' }}>
                  <WaitingSince since={a.since} now={now} />
                  <ApprovalCard agent={a.agent} title={a.title}
                    toolName={a.toolName} decisionReason={a.decisionReason} input={a.input}
                    escapedPath={a.escapedPath}
                    onAllow={() => void api.permission(a.id, 'allow')}
                    onAlways={() => void api.permission(a.id, 'allow_always')}
                    onDeny={() => void api.permission(a.id, 'deny')} />
                </div>
              ))}
            </section>
            <section>
              <SectionTitle>Questions</SectionTitle>
              {run.questions.length === 0 && <Empty>No questions from the director.</Empty>}
              {run.questions.map((q) => (
                <div key={q.id} style={{ marginBottom: 'var(--sp-2)' }}>
                  <WaitingSince since={q.since} now={now} />
                  <QuestionCard question={q.question}
                    onAnswer={(answer) => void api.answer(q.id, answer)} />
                </div>
              ))}
            </section>
            <PlanBoard doc={run.missionDoc ?? undefined} />
          </div>
        </main>
      )}
    </div>
  );
}
