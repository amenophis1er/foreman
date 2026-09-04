import { useFleet, useRoute } from './state';
import { FleetView } from './views/FleetView';
import { ProjectView } from './views/ProjectView';

export default function App() {
  const { projects, connected, auth, refresh } = useFleet();
  const { projectId, go } = useRoute();

  const project = projectId ? projects.find((p) => p.id === projectId) : null;

  return (
    <div style={{ height: '100%' }}>
      {project ? (
        <ProjectView p={project} auth={auth} onBack={() => go(null)} refreshFleet={refresh} />
      ) : (
        <FleetView projects={projects} connected={connected} auth={auth}
          onOpen={(id) => go(id)} refresh={refresh} />
      )}
    </div>
  );
}
