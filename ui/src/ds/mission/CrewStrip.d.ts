import type { CSSProperties } from 'react';

/** Crew as a row of pill chips (dot · id · status icon). Used above the transcript when the left rail is collapsed. */
export interface CrewStripProps {
  agents?: Array<{ id: string; status?: string; task?: string }>;
  filter?: string | null;
  onFilter?: (agent: string) => void;
  style?: CSSProperties;
}

export declare function CrewStrip(props: CrewStripProps): JSX.Element;
