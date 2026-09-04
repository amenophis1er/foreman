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

/** The composer's model list, from GET /models (design-system fallback inside). */
function useModels(): ModelInfo[] | null {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  useEffect(() => {
    void fetch('/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setModels(d.models))
      .catch(() => {});
  }, []);
  return models;
}

type SettingsFile = { global: Settings; projects: Record<string, Settings> };

export default function App() {
  const { projects, connected, auth, refresh, activity } = useFleet();
  const { projectId, runId, go, goRun } = useRoute();
  const [theme, toggleTheme, applyTheme] = useTheme();
  const applyTextSize = useTextSize();
  const models = useModels();
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
        <ProjectView p={project} models={models} routeRunId={runId}
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
          onSave={(v) => void saveSettings(v)}
          onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
