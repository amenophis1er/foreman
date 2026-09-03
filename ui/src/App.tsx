import { useEffect, useState } from 'react';
import { useFleet, useRoute } from './state';
import { FleetView } from './views/FleetView';
import { ProjectView } from './views/ProjectView';
import type { ModelInfo } from './ds/forms/ModelSelect';

type Theme = 'dark' | 'light';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem('foreman:theme') as Theme) || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('foreman:theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
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

export default function App() {
  const { projects, connected, refresh } = useFleet();
  const { projectId, go } = useRoute();
  const [theme, toggleTheme] = useTheme();
  const models = useModels();

  const project = projectId ? projects.find((p) => p.id === projectId) : null;

  return (
    <div style={{ height: '100%' }}>
      {project ? (
        <ProjectView p={project} models={models}
          onBack={() => go(null)} refreshFleet={refresh}
          theme={theme} onToggleTheme={toggleTheme} />
      ) : (
        <FleetView projects={projects} connected={connected}
          onOpen={(id) => go(id)} refresh={refresh}
          theme={theme} onToggleTheme={toggleTheme} />
      )}
    </div>
  );
}
