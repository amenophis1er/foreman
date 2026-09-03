const { AppHeader, Rail, SectionTitle, RunRow, Empty, Composer, ModelSelect, LayoutTier } = window.ForemanDesignSystem_5f77fb;

/** Project view, idle: history rail + centred composer. Below 900px the rail folds under the composer. */
function ComposerScreen({ project, history, theme, onToggleTheme, onBack, onSelectRun, onStart }) {
  const root = React.useRef(null);
  const tier = LayoutTier.use(root);
  const [err, setErr] = React.useState('');
  const { models, loading: modelsLoading } = ModelSelect.useModels(window.FMK.fetchModels); // GET /models in the product
  const runs = (
    <section>
      <SectionTitle>Mission history</SectionTitle>
      {history.length === 0 && <Empty>No runs yet.</Empty>}
      {history.map((r) => (
        <RunRow key={r.id} mission={r.mission} createdAt={r.createdAt} costUsd={r.costUsd} status={r.status} onSelect={() => onSelectRun(r.id)} />
      ))}
    </section>
  );
  const composer = (
    <Composer folder={project.folder} defaultBudgetUsd={5} error={err} models={models} modelsLoading={modelsLoading}
      onStart={(v) => {
        if (v.budget < 1) { setErr('budget must be at least $1'); return; }
        setErr(''); onStart(v);
      }} />
  );
  return (
    <div ref={root} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <AppHeader mode="project" title={project.name} folder={project.folder} onBack={onBack} theme={theme} onToggleTheme={onToggleTheme} />
      {tier === 'narrow' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {composer}
          <div style={{ padding: '0 var(--sp-4) var(--sp-5)', maxWidth: 'var(--composer-max)', margin: '0 auto' }}>{runs}</div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--rail-left) 1fr' }}>
          <Rail side="left">{runs}</Rail>
          <div style={{ overflowY: 'auto' }}>{composer}</div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ComposerScreen });
