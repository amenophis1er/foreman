export interface RailRun { id: string; mission: string; createdAt?: number; costUsd?: number; status: string; live?: boolean; }
export interface RailAgent { id: string; status: string; task?: string; }

/**
 * Left-rail content for the project view. The run on top owns the nested crew list; history follows.
 * Replaces the old sibling "Agents / Runs" sections.
 */
export interface RunRailProps {
  /** The run being displayed (live or replayed). */
  current?: RailRun;
  agents?: RailAgent[];
  history?: RailRun[];
  /** Id of `current`, so it is excluded from history. */
  selectedRunId?: string;
  /** Active transcript filter (agent id). */
  filter?: string | null;
  onFilter?: (agent: string) => void;
  onSelectRun?: (id: string) => void;
  /** Director session id; first 8 chars shown in mono. */
  sessionId?: string;
}

export declare function RunRail(props: RunRailProps): JSX.Element;
