import { useFleet, useRoute } from './state';
import { FleetView } from './views/FleetView';
import { ProjectView } from './views/ProjectView';

export default function App() {
  const { projects, connected, refresh } = useFleet();
  const { projectId, go } = useRoute();

  const project = projectId ? projects.find((p) => p.id === projectId) : null;

  return (
    <div style={{ height: '100%' }}>
      {project ? (
        <ProjectView p={project} onBack={() => go(null)} refreshFleet={refresh} />
      ) : (
        <FleetView projects={projects} connected={connected}
          onOpen={(id) => go(id)} refresh={refresh} />
      )}
    </div>
  );
}
