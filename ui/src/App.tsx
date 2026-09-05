import { useCallback, useEffect, useState } from 'react';
import { useFleet, useRoute } from './state';
import { FleetView } from './views/FleetView';
import { ProjectView } from './views/ProjectView';
import { SettingsModal, type Settings } from './ds/settings/SettingsModal';
import type { ModelInfo } from './ds/forms/ModelSelect';

type Theme = 'dark' | 'light';

type TextSize = 'small' | 'default' | 'large' | 'larger';

/**
 * Multipliers behind Settings → Appearance → Text size. `default` is exactly 1
 * so the browser's own font-size preference passes through untouched; the
 * other steps are deliberately coarse, because a slider of near-identical
 * sizes is a decision nobody wants to make twice.
 */
const TEXT_SCALE: Record<TextSize, number> = {
  small: 0.88, default: 1, large: 1.15, larger: 1.3,
};

/**
 * Interface text size. Held in localStorage rather than read from /settings,
 * so it is applied on the first paint instead of jumping a moment later when
 * the settings fetch lands.
 */
function useTextSize(): (t: TextSize) => void {
  const apply = useCallback((t: TextSize) => {
    const scale = TEXT_SCALE[t] ?? 1;
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    try { localStorage.setItem('foreman:textSize', t); } catch { /* optional */ }
  }, []);
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('foreman:textSize'); } catch { /* optional */ }
    if (saved && saved in TEXT_SCALE) apply(saved as TextSize);
  }, [apply]);
  return apply;
}

function useTheme(): [Theme, () => void, (t: Theme | 'system') => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem('foreman:theme') as Theme) || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('foreman:theme', theme);
  }, [theme]);
  const apply = useCallback((t: Theme | 'system') => {
    setTheme(t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : t);
  }, []);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), apply];
}

type ModelList = {
  models: ModelInfo[] | null;
  loading: boolean;
  /** Why the list is short or empty; passed to the pickers. */
  note?: string;
};

/**
 * The model list for the open project.
 *
 * Scoped to a project rather than fetched once globally, because the answer
 * belongs to that project's provider: a project pinned to an Ollama on another
 * machine must be offered that machine's models, and a global list would offer
 * it models its runs cannot reach.
 */
function useModels(projectId: string | null): ModelList {
  const [state, setState] = useState<ModelList>({ models: null, loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const url = projectId ? `/models?projectId=${encodeURIComponent(projectId)}` : '/models';
    void fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live) return;
        if (!d) return setState({ models: null, loading: false });
        setState({
          models: d.models,
          loading: false,
          // An unreachable endpoint and an endpoint with nothing installed
          // both yield an empty picker; only one of them is the operator's
          // fault, so say which.
          note: d.reachable === false
            ? `Cannot reach ${d.endpoint ?? 'this project’s endpoint'}.`
            : d.models?.length === 0
              ? 'This endpoint has no models installed.'
              : undefined,
        });
      })
      .catch(() => live && setState({ models: null, loading: false }));
    return () => { live = false; };
  }, [projectId]);
  return state;
}

type SettingsFile = { global: Settings; projects: Record<string, Settings> };

export default function App() {
  const { projects, connected, auth, refresh, activity } = useFleet();
  const { projectId, runId, go, goRun } = useRoute();
  const [theme, toggleTheme, applyTheme] = useTheme();
  const applyTextSize = useTextSize();
  // Settings can be opened over a project, so both surfaces want the same
  // provider-scoped list.
  const models = useModels(projectId);
  const [settings, setSettings] = useState<SettingsFile>({ global: {}, projects: {} });
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void fetch('/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSettings(d))
      .catch(() => {});
  }, []);

  const project = projectId ? projects.find((p) => p.id === projectId) : null;

  const saveSettings = async (v: { global: Settings; project: Settings }) => {
    const next: SettingsFile = {
      global: v.global,
      projects: { ...settings.projects },
    };
    if (project) {
      if (Object.keys(v.project).length) next.projects[project.id] = v.project;
      else delete next.projects[project.id];
    }
    setSettings(next);
    setSettingsOpen(false);
    if (v.global.theme) applyTheme(v.global.theme);
    if (v.global.textSize) applyTextSize(v.global.textSize);
    await fetch('/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        global: v.global,
        projectId: project?.id,
        project: project ? next.projects[project.id] ?? {} : undefined,
      }),
    }).catch(() => {});
  };

  const shared = {
    theme, onToggleTheme: toggleTheme,
    onSettings: () => setSettingsOpen(true),
    // Which account pays. Cross-cutting, so it rides with the other shell props.
    auth,
  };

  return (
    <div style={{ height: '100%' }}>
      {project ? (
        <ProjectView p={project} models={models.models} modelsLoading={models.loading}
          modelsNote={models.note} routeRunId={runId}
          onSelectRun={(id) => goRun(project.id, id)}
          onBack={() => go(null)} refreshFleet={refresh} {...shared} />
      ) : (
        <FleetView projects={projects} connected={connected} activity={activity}
          onOpen={(id) => go(id)} refresh={refresh} {...shared} />
      )}
      {settingsOpen && (
        <SettingsModal
          global={settings.global}
          project={project ? settings.projects[project.id] : undefined}
          projectName={project?.name}
          models={models.models} modelsLoading={models.loading} modelsNote={models.note}
          onSave={(v) => void saveSettings(v)}
          onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
