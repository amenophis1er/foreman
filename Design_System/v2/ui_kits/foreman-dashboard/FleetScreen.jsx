const { AppHeader, ProjectCard, LinkProjectCard, Empty, Banner, FolderPicker, DropConfirmModal, DropOverlay, ConfirmDialog } = window.ForemanDesignSystem_5f77fb;

function FleetScreen({ projects, connected, theme, onToggleTheme, onOpen, onUnlink, onLink }) {
  const [picker, setPicker] = React.useState(false);
  const [path, setPath] = React.useState('/Users/you/Projects/personal-foreman/scratchpad');
  const [dragging, setDragging] = React.useState(false);
  const [drop, setDrop] = React.useState(null);
  const [confirm, setConfirm] = React.useState(null);
  const cur = window.FMK.FOLDERS[path] ?? { parent: null, dirs: [] };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    setDrop({ name: 'fleet-gamma', matches: null });
    setTimeout(() => setDrop({ name: 'fleet-gamma', matches: ['/Users/you/Projects/personal-foreman/scratchpad/fleet-gamma', '/Users/you/Archive/2025/fleet-gamma'] }), 900);
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', position: 'relative' }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.target === e.currentTarget) setDragging(false); }}
      onDrop={onDrop}>
      {dragging && <DropOverlay />}
      <AppHeader mode="fleet" theme={theme} onToggleTheme={onToggleTheme}>
        {!connected && <Banner tone="disconnected" inline>disconnected</Banner>}
      </AppHeader>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 'var(--sp-4)', padding: 'var(--sp-5)', maxWidth: 'var(--fleet-max)', margin: '0 auto',
      }}>
        {projects.map((p) => (
          <ProjectCard key={p.id} name={p.name} folder={p.folder} run={p.activeRun} lastRun={p.lastRun}
            pendingPermissions={p.pendingPermissions} pendingQuestions={p.pendingQuestions}
            onOpen={() => onOpen(p.id)} onUnlink={() => setConfirm(p)} />
        ))}
        <LinkProjectCard onClick={() => setPicker(true)} />
        {projects.length === 0 && (
          <div style={{ gridColumn: '1 / -1' }}>
            <Empty>No projects linked yet — link a folder to give the director a job site.</Empty>
          </div>
        )}
      </div>
      {picker && (
        <FolderPicker path={path} parent={cur.parent} dirs={cur.dirs} onNavigate={setPath} onCreate={() => {}}
          onPick={(p) => { setPicker(false); onLink(p); }} onClose={() => setPicker(false)} />
      )}
      {drop && (
        <DropConfirmModal name={drop.name} matches={drop.matches} onPick={(p) => { setDrop(null); onLink(p); }} onClose={() => setDrop(null)} />
      )}
      {confirm && (
        <ConfirmDialog icon="unlink" title={`Unlink ${confirm.name}?`}
          body={<>Foreman stops tracking <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{confirm.folder}</code>. Run history and its <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>.foreman/</code> files stay on disk; you can link it again later.</>}
          confirmLabel="Unlink" onConfirm={() => { onUnlink(confirm.id); setConfirm(null); }} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}

Object.assign(window, { FleetScreen });
