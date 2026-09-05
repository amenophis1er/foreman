import type { CSSProperties, ReactNode } from 'react';

/**
 * The Crew tab of the mission body: the crew tree with each worker's current progress line,
 * the run's properties (`details` — models, budget, browser, resumes), and the director
 * session id. The old left rail's content, as a tab.
 */
export interface CrewTabProps {
  /** `task` is the worker's latest progress status, or its brief before it has reported. */
  agents?: Array<{ id: string; status?: string; task?: string }>;
  /** Active transcript filter (agent id). */
  filter?: string | null;
  /** Toggle the transcript filter to this agent. */
  onFilter?: (agent: string) => void;
  /** Director session id; first 8 chars shown in mono. */
  sessionId?: string;
  /** The run-properties block (a `RunDetails`), rendered under a `Run` title. */
  details?: ReactNode;
  style?: CSSProperties;
}

export declare function CrewTab(props: CrewTabProps): JSX.Element;
