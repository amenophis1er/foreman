export interface ArtifactViewerArtifact {
  path: string;
  /** `diff` is a changed file from the deck: the body is its unified diff, the header its status and +/−. */
  kind: 'image' | 'text' | 'pdf' | 'other' | 'diff';
  size?: number;
  diff?: string;
  truncated?: boolean;
  binary?: boolean;
  status?: string;
  additions?: number;
  deletions?: number;
}

export interface ArtifactViewerProps {
  /** What to show; `null` renders nothing. */
  artifact: ArtifactViewerArtifact | null;
  /** The artifact route for this file; also what "Open in a new tab" links to. Omit for a `diff` item. */
  url?: string;
  /** The sandboxed preview route for this file. When given for an HTML artifact, the header gains Rendered | Source. */
  previewUrl?: string;
  onClose: () => void;
  /** Position in the list being browsed, 0-based. With `count` and `onStep`, the header gains prev/next and ← → step through the list. */
  index?: number;
  count?: number;
  onStep?: (index: number) => void;
}

/** A modal that shows one deck artifact in place: images fit, text and code render as a mono block (Markdown rendered), PDFs frame the browser viewer, other kinds offer the file. Escape and the backdrop close it. */
export declare function ArtifactViewer(props: ArtifactViewerProps): JSX.Element | null;
