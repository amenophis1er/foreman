import { useEffect, useRef, useState } from 'react';
import {
  api, useRunHistory, useRunView,
  type ProjectSummary, type RunView as RunViewState,
} from '../state';
import { AppHeader } from '../ds/shell/AppHeader';
import { Button } from '../ds/core/Button';
import { Empty } from '../ds/core/Empty';
import { SectionTitle } from '../ds/core/SectionTitle';
import { Banner } from '../ds/status/Banner';
import { StatusBadge } from '../ds/status/StatusBadge';
import { BudgetMeter } from '../ds/status/BudgetMeter';
import { AttentionBar } from '../ds/status/AttentionBar';
import { RunRail } from '../ds/mission/RunRail';
import { RunTimeline } from '../ds/mission/RunTimeline';
import { TranscriptEntry } from '../ds/mission/TranscriptEntry';
import { ApprovalCard } from '../ds/mission/ApprovalCard';
import { QuestionCard } from '../ds/mission/QuestionCard';
import { PlanBoard } from '../ds/mission/PlanBoard';
import { Composer } from '../ds/mission/Composer';
import type { ModelInfo } from '../ds/forms/ModelSelect';

function Transcript({ run, filter, header }: {
  run: RunViewState; filter: string | null; header?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const shown = filter ? run.entries.filter((e) => e.agent === filter) : run.entries;

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      style={{
        overflowY: 'auto', padding: 'var(--sp-3)', minHeight: 0, flex: 1,
        display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      }}>
      {header}
      {shown.length === 0 && <Empty>Transcript will appear here.</Empty>}
      {shown.map((e) => (
        <TranscriptEntry key={e.id} agent={e.agent} title={e.title}
          kind={e.kind} body={e.body} ts={e.ts} />
      ))}
    </div>
  );
}

export function ProjectView({ p, models, onBack, refreshFleet, theme, onToggleTheme }: {
  p: ProjectSummary; models: ModelInfo[] | null;
  onBack: () => void; refreshFleet: () => void;
  theme: 'dark' | 'light'; onToggleTheme: () => void;
}) {
  const history = useRunHistory(p.id);
  const activeRunId = p.activeRun?.id ?? null;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(activeRunId);
  useEffect(() => {
    if (activeRunId) setSelectedRunId(activeRunId);
  }, [activeRunId]);

  const viewingLive = selectedRunId !== null && selectedRunId === activeRunId;
  const run = useRunView(selectedRunId, viewingLive);
  const selectedRun = history.find((r) => r.id === selectedRunId);
  const [filter, setFilter] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
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
    createdAt: selectedRun?.createdAt,
    costUsd: run.costUsd,
    status: run.runStatus,
    live: viewingLive && run.runStatus === 'running',
  } : undefined;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <AppHeader mode="project" title={p.name} folder={p.folder} onBack={onBack}
        theme={theme} onToggleTheme={onToggleTheme}>
        {headerErr && <Banner tone="error" inline>{headerErr}</Banner>}
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
          <div style={{ overflowY: 'auto' }}>
            <Composer folder={p.folder} defaultBudgetUsd={p.defaultBudgetUsd}
              error={composerErr} busy={starting} models={models}
              onStart={(v) => void startMission(v)} />
          </div>
        </div>
      ) : (
        <main style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--rail-left) 1fr var(--rail-right)' }}>
          <div style={{ borderRight: '1px solid var(--line)', background: 'var(--bg-panel)', minHeight: 0, minWidth: 0, overflow: 'hidden auto', padding: 'var(--sp-3)' }}>
            <RunRail current={railCurrent} agents={run.agents} history={history}
              selectedRunId={selectedRunId ?? undefined}
              filter={filter} onFilter={(a) => setFilter(filter === a ? null : a)}
              onSelectRun={setSelectedRunId}
              sessionId={run.directorSessionId} />
          </div>
          <div style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {(run.entries.length > 0 || run.approvals.length + run.questions.length > 0) && (
              <div style={{
                padding: 'var(--sp-3) var(--sp-3) 0', display: 'flex',
                flexDirection: 'column', gap: 'var(--sp-2)', flex: '0 0 auto',
              }}>
                {run.entries.length > 0 && (
                  <RunTimeline agents={run.agents} entries={run.entries}
                    live={viewingLive && run.runStatus === 'running'}
                    selected={filter}
                    onSelect={(a) => setFilter(filter === a ? null : a)} />
                )}
                <AttentionBar approvals={run.approvals.length} questions={run.questions.length}
                  onReview={() => rightRail.current?.scrollIntoView({ behavior: 'smooth' })} />
              </div>
            )}
            <Transcript run={run} filter={filter} />
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
