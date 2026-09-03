import type { CSSProperties } from 'react';

/** Dashed add-tile, same footprint as a ProjectCard. Opens the FolderPicker. */
export interface LinkProjectCardProps {
  onClick?: () => void;
  style?: CSSProperties;
}

export declare function LinkProjectCard(props: LinkProjectCardProps): JSX.Element;
