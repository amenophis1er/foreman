import React, { useEffect, useRef, useState } from 'react';
import {
  api, useRunHistory, useRunView,
  type ProjectSummary, type RunSummary, type RunView as RunViewState,
} from '../state';
import { AppHeader } from '../ds/shell/AppHeader';
import { Button } from '../ds/core/Button';
import { Empty } from '../ds/core/Empty';
import { SectionTitle } from '../ds/core/SectionTitle';
import { Banner } from '../ds/status/Banner';
import { StatusBadge } from '../ds/status/StatusBadge';
import { BillingBadge, type BillingMode } from '../ds/status/BillingBadge';
import { BudgetMeter } from '../ds/status/BudgetMeter';
import { AttentionBar } from '../ds/status/AttentionBar';
import { RunRail } from '../ds/mission/RunRail';
import { RunTimeline } from '../ds/mission/RunTimeline';
import { TranscriptEntry } from '../ds/mission/TranscriptEntry';
import { ApprovalCard } from '../ds/mission/ApprovalCard';
import { QuestionCard } from '../ds/mission/QuestionCard';
import { PlanBoard } from '../ds/mission/PlanBoard';
import { Composer } from '../ds/mission/Composer';
import { SteerBar } from '../ds/mission/SteerBar';
import type { ModelInfo } from '../ds/forms/ModelSelect';

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

/** Key run properties (models, budget, browser), pulled from run metadata. */
function RunDetails({ r, liveCost }: { r: RunSummary; liveCost?: number }) {
  const rows: Array<[string, string]> = [
    ['director', r.directorModel || 'default'],
    ['workers', r.workerModel || 'default'],
    ['budget', `$${((liveCost ?? r.costUsd) || 0).toFixed(2)} / $${r.budgetUsd.toFixed(2)}`],
    ['browser', r.browserTools ? 'on' : 'off'],
  ];
  if (r.resumes) rows.push(['resumes', String(r.resumes)]);
  return (
    <div style={{
      marginTop: 8, display: 'grid', gridTemplateColumns: 'auto 1fr',
      columnGap: 10, rowGap: 2, fontSize: 'var(--fs-xs)',
    }}>
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <span style={{ color: 'var(--ink-2)' }}>{k}</span>
          <span style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export function ProjectView({
  p, models, routeRunId, onSelectRun, onBack, refreshFleet, auth, theme, onToggleTheme, onSettings,
}: {
  p: ProjectSummary; models: ModelInfo[] | null;
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

  const doResume = async () => {
    if (!selectedRunId) return;
    setHeaderErr('');
    setResuming(true);
    const r = await api.resume(selectedRunId).finally(() => setResuming(false));
    if (!r.ok) setHeaderErr((await r.json()).error);
    else refreshFleet();
  };

  const startMission = async (v: {
    mission: string; budget: number; directorModel: string; workerModel: string;
    browserTools?: boolean;
  }) => {
    setComposerErr('');
    setStarting(true);
    const r = await api
      .run(p.id, v.mission, v.budget, v.directorModel, v.workerModel, Boolean(v.browserTools))
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
          source={p.claudeInstance?.billing === 'own-login'
            ? `${p.claudeInstance.configDir} (this project's own login)`
            : auth.source} />
        {selectedRunId && <StatusBadge status={run.runStatus} />}
        {selectedRunId && <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} />}
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
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {/* margin:auto centers the card vertically yet degrades to normal
                flow (scrollable) when the composer is taller than the view. */}
            <div style={{ margin: 'auto', width: '100%', padding: 'var(--sp-5) 0' }}>
              <Composer folder={p.folder} defaultBudgetUsd={p.defaultBudgetUsd}
                error={composerErr} busy={starting} models={models}
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
                  source={p.claudeInstance?.billing === 'own-login'
                    ? `${p.claudeInstance.configDir} (this project's own login)`
                    : auth.source} />
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  runs on {p.claudeInstance?.configDir ?? 'the server default instance'}
                </span>
              </div>
            </div>
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
              details={selectedRun && <RunDetails r={selectedRun} liveCost={run.costUsd} />} />
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
                <ApprovalCard key={a.id} agent={a.agent} title={a.title}
                  toolName={a.toolName} decisionReason={a.decisionReason} input={a.input}
                  onAllow={() => void api.permission(a.id, 'allow')}
                  onAlways={() => void api.permission(a.id, 'allow_always')}
                  onDeny={() => void api.permission(a.id, 'deny')}
                  style={{ marginBottom: 'var(--sp-2)' }} />
              ))}
            </section>
            <section>
              <SectionTitle>Questions</SectionTitle>
              {run.questions.length === 0 && <Empty>No questions from the director.</Empty>}
              {run.questions.map((q) => (
                <QuestionCard key={q.id} question={q.question}
                  onAnswer={(answer) => void api.answer(q.id, answer)}
                  style={{ marginBottom: 'var(--sp-2)' }} />
              ))}
            </section>
            <PlanBoard doc={run.missionDoc ?? undefined} />
          </div>
        </main>
      )}
    </div>
  );
}
