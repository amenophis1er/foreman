import type { CSSProperties } from 'react';

/** One agent in the crew list. Clicking filters the transcript to it; clicking again clears the filter. */
export interface AgentRowProps {
  /** Agent id, shown verbatim (`director`, `worker-1`). */
  agent: string;
  status?: 'idle' | 'running' | 'done' | 'error' | 'interrupted';
  /** First 500 chars of the worker's brief — becomes the row tooltip. */
  task?: string;
  selected?: boolean;
  /** Indent under the director with a tree connector. True for workers. */
  indent?: boolean;
  /** Last worker in the list — shortens the tree line. */
  last?: boolean;
  onSelect?: (agent: string) => void;
  style?: CSSProperties;
}

export declare function AgentRow(props: AgentRowProps): JSX.Element;
