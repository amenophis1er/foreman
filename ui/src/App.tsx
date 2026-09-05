import { useCallback, useEffect, useState } from 'react';
import { api, useFleet, useRoute } from './state';
import { FleetView } from './views/FleetView';
import { ProjectView } from './views/ProjectView';
import { SettingsModal, type Settings } from './ds/settings/SettingsModal';
import type {
  DiscoveredInstance, OllamaInfo, ProviderRef,
} from './ds/settings/ProviderPicker';
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
  /** What the pickers' "Default" row inherits from, for this provider. */
  inheritNote?: string;
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
          inheritNote: d.provider && d.provider !== 'claude-code'
            ? 'inherits this project’s provider default'
            : undefined,
        });
      })
      .catch(() => live && setState({ models: null, loading: false }));
    return () => { live = false; };
  }, [projectId]);
  return state;
}

type SettingsFile = { global: Settings; projects: Record<string, Settings> };

/**
 * What Settings needs to offer providers as choices rather than free text: the
 * Claude Code installs on this machine and a running Ollama, if there is one.
 *
 * Fetched when the modal opens rather than at boot — an install can appear
 * (`claude login` in another terminal) or a daemon can start while Foreman is
 * running, and a stale list would quietly hide the thing the operator just
 * created.
 */
function useProviderChoices(open: boolean) {
  const [choices, setChoices] = useState<{
    instances: DiscoveredInstance[];
    ollama: OllamaInfo | null;
  }>({ instances: [], ollama: null });

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetch('/instances')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setChoices({ instances: d.instances ?? [], ollama: d.ollama ?? null });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [open]);

  return choices;
}

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
  const providerChoices = useProviderChoices(settingsOpen);

  useEffect(() => {
    void fetch('/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSettings(d))
      .catch(() => {});
  }, []);

  const project = projectId ? projects.find((p) => p.id === projectId) : null;

  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');

  /**
   * A provider's key is written the moment it is submitted, to its own
   * endpoint — not folded into Settings' Save. It is a different resource with
   * different rules (write-only, 0600 on disk), and a credential that is
   * half-saved because someone hit Cancel is worse than one saved plainly.
   */
  const providerId = project && 'id' in (project.provider ?? {})
    ? (project.provider as { id?: string }).id : undefined;

  const writeKey = async (key: string | null) => {
    if (!providerId) return;
    setKeyError('');
    setKeyBusy(true);
    const r = await (key === null
      ? api.clearProviderKey(providerId)
      : api.setProviderKey(providerId, key)).finally(() => setKeyBusy(false));
    if (!r.ok) setKeyError((await r.json().catch(() => ({}))).error ?? 'could not save the key');
    else refresh(); // providerHasKey rides on the fleet poll
  };


  const saveSettings = async (v: {
    global: Settings; project: Settings; provider?: ProviderRef | null;
  }) => {
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

    // A provider is a property of the project, not of the settings overlay, so
    // it goes to its own endpoint. `undefined` means the pin was not touched;
    // `null` clears it back to the server default.
    if (project && v.provider !== undefined) {
      await api.updateProject(project.id, { provider: v.provider }).catch(() => {});
      // The fleet poll carries billingMode and the provider itself, and both
      // just changed — refresh rather than wait up to three seconds to stop
      // showing the old payer.
      refresh();
    }
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
          modelsNote={models.note} modelsInheritNote={models.inheritNote} routeRunId={runId}
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
          provider={project?.provider ?? null}
          providerInstances={providerChoices.instances}
          providerOllama={providerChoices.ollama}
          providerHasKey={project?.providerHasKey}
          providerKeyBusy={keyBusy} providerKeyError={keyError}
          onStoreProviderKey={providerId ? (k) => void writeKey(k) : undefined}
          onClearProviderKey={providerId ? () => void writeKey(null) : undefined}
          onSave={(v) => void saveSettings(v)}
          onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
