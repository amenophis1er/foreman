import type { CSSProperties } from 'react';
import type { FilesPanelArtifact } from './FilesPanel';

export interface FolderBrowserProps {
  /** Every file under the project folder, paths relative to it. */
  files: FilesPanelArtifact[];
  /** The server stopped at its cap; the list is a prefix of the folder. */
  truncated?: boolean;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  /** Where artifact/preview URLs are served from, e.g. `/projects/{id}`. */
  urlBase: string;
  /** The directory to open in; '' is the root. */
  initialDir?: string;
  /** The line above the path bar; `null` hides it, undefined gives the project default. */
  summary?: React.ReactNode | null;
  style?: CSSProperties;
}

/** The project's folder in the rail: one directory at a time with a path bar; a file opens in `ArtifactViewer`. */
export declare function FolderBrowser(props: FolderBrowserProps): JSX.Element;
/** The deepest directory every path shares; '' when they share none. */
export declare function commonDir(files: Array<{ path: string }>): string;
