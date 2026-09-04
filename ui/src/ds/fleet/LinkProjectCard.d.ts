import type { CSSProperties } from 'react';

/** Dashed add-tile for the fleet's empty state. Opens the FolderPicker. With
 *  projects present the action lives in the header instead — see the prompt. */
export interface LinkProjectCardProps {
  onClick?: () => void;
  style?: CSSProperties;
}

export declare function LinkProjectCard(props: LinkProjectCardProps): JSX.Element;
