const {
  AppHeader, Rail, SectionTitle, Empty, Banner, Button, StatusBadge, BudgetMeter, Tabs, LayoutTier,
  RunRail, CrewStrip, TranscriptEntry, ApprovalCard, QuestionCard, PlanBoard, RunTimeline, AttentionBar,
} = window.ForemanDesignSystem_5f77fb;

function Transcript({ entries, filter, header, style }) {
  const box = React.useRef(null);
  const pinned = React.useRef(true);
  const shown = filter ? entries.filter((e) => e.agent === filter) : entries;
  React.useEffect(() => { const el = box.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [shown.length]);
  const onScroll = () => { const el = box.current; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  return (
    <div ref={box} onScroll={onScroll} style={{ overflowY: 'auto', padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', minHeight: 0, ...style }}>
      {header}
      {shown.length === 0 && <Empty>Transcript will appear here.</Empty>}
      {shown.map((e) => <TranscriptEntry key={e.id} agent={e.agent} title={e.title} kind={e.kind} body={e.body} ts={e.ts} />)}
    </div>
  );
}

function RightRailContent({ run, onAnswer, onApprove, onDeny }) {
  return (
    <>
      <section>
        <SectionTitle>Approvals</SectionTitle>
        {run.approvals.length === 0 && <Empty>No pending approvals.</Empty>}
        {run.approvals.map((a) => (
          <ApprovalCard key={a.id} agent={a.agent} title={a.title} input={a.input} decisionReason={a.decisionReason}
            onAllow={() => onApprove(a.id)} onAlways={() => onApprove(a.id)} onDeny={() => onDeny(a.id)} />
        ))}
      </section>
      <section>
        <SectionTitle>Questions</SectionTitle>
        {run.questions.length === 0 && <Empty>No questions from the director.</Empty>}
        {run.questions.map((q) => <QuestionCard key={q.id} question={q.question} onAnswer={(a) => onAnswer(q.id, a)} />)}
      </section>
      <PlanBoard doc={run.missionDoc} />
    </>
  );
}

/** Project view with a run displayed — live or replayed. Three tiers: wide (3 col), medium (2 col + crew strip), narrow (tabs). */
function MissionScreen({
  project, run, history, selectedRunId, readOnly, resumable, theme, onToggleTheme, onBack, onSelectRun,
  onAnswer, onApprove, onDeny, onInterrupt, onResume, onNewMission,
}) {
  const root = React.useRef(null);
  const rightRail = React.useRef(null);
  const tier = LayoutTier.use(root);
  const [filter, setFilter] = React.useState(null);
  const [view, setView] = React.useState('transcript');
  const [showTimeline, setShowTimeline] = React.useState(true);
  const [resuming, setResuming] = React.useState(false);
  const toggle = (id) => setFilter((f) => (f === id ? null : id));
  const pending = run.approvals.length + run.questions.length;
  const live = run.runStatus === 'running';

  React.useEffect(() => { if (pending === 0 && view === 'needs') setView('transcript'); }, [pending]);

  const review = () => {
    if (tier === 'narrow') setView('needs');
    else if (rightRail.current) rightRail.current.scrollTop = 0;
  };

  const current = { id: selectedRunId, mission: run.mission, createdAt: run.createdAt, costUsd: run.costUsd, status: run.runStatus, live: !readOnly };
  const leftRail = (
    <RunRail current={current} agents={run.agents} history={history} selectedRunId={selectedRunId}
      filter={filter} onFilter={toggle} onSelectRun={onSelectRun} sessionId={run.directorSessionId} />
  );
  const timelineStrip = run.entries.length > 0 && (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '8px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: showTimeline ? 8 : 0, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)' }}>
        Timeline<span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" icon={showTimeline ? 'chevronDown' : 'chevronRight'} onClick={() => setShowTimeline(!showTimeline)}>{showTimeline ? 'Hide' : 'Show'}</Button>
      </div>
      {showTimeline && <RunTimeline agents={run.agents} entries={run.entries} live={live} selected={filter} onSelect={toggle} />}
    </div>
  );
  const transcriptHeader = (
    <>
      <AttentionBar approvals={run.approvals.length} questions={run.questions.length} onReview={review} />
      {tier === 'medium' && <CrewStrip agents={run.agents} filter={filter} onFilter={toggle} />}
      {timelineStrip}
    </>
  );

  return (
    <div ref={root} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <AppHeader mode="project" title={project.name} folder={project.folder} onBack={onBack} theme={theme} onToggleTheme={onToggleTheme}>
        <StatusBadge status={run.runStatus} />
        <BudgetMeter spent={run.costUsd} budget={run.budgetUsd} />
        {!readOnly && live && <Button variant="danger" onClick={onInterrupt}>Interrupt</Button>}
        {resumable && (
          <Button variant="good" icon="resume" disabled={resuming} title="Restore the director's session and continue this mission"
            onClick={() => { setResuming(true); setTimeout(() => { setResuming(false); onResume(); }, 700); }}>
            {resuming ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {!live && <Button variant="primary" onClick={onNewMission}>New mission</Button>}
      </AppHeader>
      {readOnly && <Banner tone="readonly">Viewing a past run (read-only).</Banner>}

      {tier === 'wide' && (
        <main style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--rail-left) 1fr var(--rail-right)' }}>
          <Rail side="left">{leftRail}</Rail>
          <Transcript entries={run.entries} filter={filter} header={transcriptHeader} />
          <div ref={rightRail} style={{ display: 'contents' }}><Rail side="right" style={{ scrollBehavior: 'smooth' }}><RightRailContent run={run} onAnswer={onAnswer} onApprove={onApprove} onDeny={onDeny} /></Rail></div>
        </main>
      )}
      {tier === 'medium' && (
        <main style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 320px' }}>
          <Transcript entries={run.entries} filter={filter} header={transcriptHeader} />
          <Rail side="right"><RightRailContent run={run} onAnswer={onAnswer} onApprove={onApprove} onDeny={onDeny} /></Rail>
        </main>
      )}
      {tier === 'narrow' && (
        <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 12px 0', display: 'flex', justifyContent: 'center' }}>
            <Tabs value={view} onChange={setView} tabs={[
              { value: 'crew', label: 'Crew', icon: 'crew' },
              { value: 'transcript', label: 'Transcript', icon: 'transcript' },
              { value: 'needs', label: 'Needs you', icon: 'needsYou', count: pending, attention: true },
            ]} />
          </div>
          {view === 'crew' && <Rail side="left" style={{ flex: 1, borderRight: 'none', background: 'transparent' }}>{leftRail}</Rail>}
          {view === 'transcript' && <Transcript entries={run.entries} filter={filter} header={transcriptHeader} style={{ flex: 1 }} />}
          {view === 'needs' && <Rail side="right" style={{ flex: 1, borderLeft: 'none', background: 'transparent' }}><RightRailContent run={run} onAnswer={onAnswer} onApprove={onApprove} onDeny={onDeny} /></Rail>}
        </main>
      )}
    </div>
  );
}

Object.assign(window, { MissionScreen });
