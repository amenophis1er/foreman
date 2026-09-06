import type { CSSProperties, ReactNode } from 'react';

export interface CrewPanelAgent {
  id: string;
  status: 'idle' | 'running' | 'done' | 'error' | 'interrupted';
  /** The worker's latest progress line, or its brief's first line. */
  task?: string;
}

export interface CrewPanelProps {
  agents?: CrewPanelAgent[];
  /** Agent the transcript is filtered to; clicking a row toggles it. */
  filter?: string | null;
  onFilter?: (agent: string) => void;
  /** Director session id; the first eight characters are shown. */
  sessionId?: string;
  /** The run's own properties (models, budget, browser, cost) — a `RunDetails` block. */
  details?: ReactNode;
  style?: CSSProperties;
}

/** Crew and run facts, stacked for the mission rail under the DONE WHEN list. Status, not a surface. */
export declare function CrewPanel(props: CrewPanelProps): JSX.Element;
