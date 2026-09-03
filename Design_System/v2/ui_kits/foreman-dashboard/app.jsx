const { FMK } = window;

function useTheme() {
  const [theme, setTheme] = React.useState(() => { try { return localStorage.getItem('foreman:theme') || 'dark'; } catch { return 'dark'; } });
  React.useEffect(() => {
    if (theme === 'light') document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('foreman:theme', theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

/** Router + fake orchestrator for the Foreman dashboard kit. One active mission per project. */
function App() {
  const [theme, toggleTheme] = useTheme();
  const [projects, setProjects] = React.useState([
    { id: 'p1', name: 'Alpha', folder: '/Users/you/Projects/personal-foreman/scratchpad/fleet-alpha', activeRun: null, pendingPermissions: 0, pendingQuestions: 0, lastRun: FMK.HISTORY[0] },
    { id: 'p2', name: 'Beta', folder: '/Users/you/Projects/personal-foreman/scratchpad/fleet-beta', activeRun: null, pendingPermissions: 0, pendingQuestions: 0, lastRun: FMK.HISTORY[2] },
    { id: 'p3', name: 'website', folder: '/Users/you/Projects/website', activeRun: null, pendingPermissions: 0, pendingQuestions: 0 },
  ]);
  const [route, setRoute] = React.useState(null);
  const [phase, setPhase] = React.useState(null);
  const [interrupted, setInterrupted] = React.useState(false);
  const [replayId, setReplayId] = React.useState(null);
  const [history, setHistory] = React.useState(FMK.HISTORY);
  const [connected] = React.useState(true);

  const project = projects.find((p) => p.id === route) ?? null;
  const live = phase && route === 'p1';
  const run = live ? FMK.runAt(phase, { interrupted }) : null;

  React.useEffect(() => {
    setProjects((ps) => ps.map((p) => (p.id === 'p1'
      ? (run ? {
        ...p,
        activeRun: run.runStatus === 'running' ? { mission: run.mission, costUsd: run.costUsd, budgetUsd: run.budgetUsd } : null,
        pendingPermissions: run.approvals.length, pendingQuestions: run.questions.length,
      } : { ...p, activeRun: null, pendingPermissions: 0, pendingQuestions: 0 })
      : p)));
  }, [phase, interrupted]);

  const themeProps = { theme, onToggleTheme: toggleTheme };

  if (!project) {
    return (
      <window.FleetScreen projects={projects} connected={connected} {...themeProps}
        onOpen={setRoute}
        onUnlink={(id) => setProjects((ps) => ps.filter((p) => p.id !== id))}
        onLink={(folder) => {
          const id = 'p' + (projects.length + 1);
          setProjects((ps) => [...ps, { id, name: folder.split('/').pop(), folder, activeRun: null, pendingPermissions: 0, pendingQuestions: 0 }]);
          setRoute(id);
        }} />
    );
  }

  const replay = replayId ? history.find((r) => r.id === replayId) : null;
  if (replay) {
    const r = FMK.runAt('finished', { interrupted: replay.status === 'interrupted' });
    return (
      <window.MissionScreen project={project} history={history} selectedRunId={replayId} readOnly {...themeProps}
        resumable={replay.status === 'interrupted'}
        run={{ ...r, runStatus: replay.status, costUsd: replay.costUsd, mission: replay.mission, createdAt: replay.createdAt }}
        onBack={() => { setReplayId(null); setRoute(null); }}
        onSelectRun={setReplayId}
        onNewMission={() => setReplayId(null)}
        onResume={() => { setReplayId(null); setPhase('verifying'); setInterrupted(false); }}
        onAnswer={() => {}} onApprove={() => {}} onDeny={() => {}} onInterrupt={() => {}} />
    );
  }

  if (!live) {
    return (
      <window.ComposerScreen project={project} history={history} {...themeProps}
        onBack={() => setRoute(null)}
        onSelectRun={setReplayId}
        onStart={() => { setInterrupted(false); setPhase('planning'); setTimeout(() => setPhase('question'), 1400); }} />
    );
  }

  return (
    <window.MissionScreen project={project} run={{ ...run, createdAt: Date.now() - 60000 }} history={history} selectedRunId="live" {...themeProps}
      readOnly={false} resumable={interrupted}
      onBack={() => setRoute(null)}
      onSelectRun={setReplayId}
      onAnswer={() => setPhase('spawning')}
      onApprove={() => { setPhase('verifying'); setTimeout(() => setPhase('finished'), 1600); }}
      onDeny={() => setInterrupted(true)}
      onInterrupt={() => setInterrupted(true)}
      onResume={() => setInterrupted(false)}
      onNewMission={() => {
        setHistory((h) => [{ id: 'r-live-' + Date.now(), mission: run.mission, createdAt: Date.now(), costUsd: run.costUsd, status: run.runStatus }, ...h]);
        setProjects((ps) => ps.map((p) => (p.id === 'p1' ? { ...p, lastRun: { mission: run.mission, createdAt: Date.now(), costUsd: run.costUsd, status: run.runStatus } } : p)));
        setPhase(null);
      }} />
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
