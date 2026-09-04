import type { CSSProperties } from 'react';

/** A file attached to a mission brief. Icon is derived from the extension (image / code / file). */
export interface AttachmentChipProps {
  name: string;
  /** Bytes; formatted as B / KB / MB. */
  size?: number;
  /** Renders the × button when present. */
  onRemove?: () => void;
  style?: CSSProperties;
}

export declare function AttachmentChip(props: AttachmentChipProps): JSX.Element;
export declare function formatBytes(n?: number): string;
