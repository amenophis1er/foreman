import type { CSSProperties } from 'react';

export interface FilesPanelFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary?: boolean;
  diff?: string;
  truncated?: boolean;
  preexisting?: boolean;
}

export interface FilesPanelArtifact {
  path: string;
  kind: 'image' | 'text' | 'pdf' | 'other';
  size: number;
  mtimeMs: number;
}

export interface FilesPanelDeck {
  runId: string;
  baseline: { kind: 'git' | 'snapshot' | 'none'; at?: number; head?: string | null };
  files: FilesPanelFile[];
  artifacts: FilesPanelArtifact[];
  totals: { files: number; additions: number; deletions: number };
  note?: string;
}

export interface FilesPanelProps {
  runId: string;
  deck: FilesPanelDeck | null;
  loading?: boolean;
  error?: string | null;
  /** The server has no baseline for this run (404). */
  missing?: boolean;
  /** Dev servers the crew exposed; each opens in a new tab through Foreman's proxy. */
  services?: Array<{ port: number; label: string; path: string; since: number }>;
  style?: CSSProperties;
}

/** The mission rail's Files tab: changed files (status, +/−) and artifacts (thumbnails, work files) as a rail-width list; any row opens `ArtifactViewer`, where ← → step through the whole deck. */
export declare function FilesPanel(props: FilesPanelProps): JSX.Element;
