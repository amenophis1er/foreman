import type { CSSProperties, ReactNode } from 'react';

/**
 * The one overlay shape: 55% black scrim, panel-surface sheet on a strong hairline, 10px radius,
 * 70vh max height, header/scroll body/footer. No animation on open or close.
 */
export interface ModalProps {
  /** 480 for the folder picker, 520 for the drop confirm. */
  width?: number;
  children: ReactNode;
  /** Called on backdrop click. There is no close button in the corner. */
  onClose?: () => void;
  /** Default true. `false` ignores backdrop clicks — the modal closes only through its own buttons (SettingsModal). */
  dismissible?: boolean;
  style?: CSSProperties;
}

export declare function Modal(props: ModalProps): JSX.Element;
export declare function ModalHeader(props: { children: ReactNode; style?: CSSProperties }): JSX.Element;
export declare function ModalFooter(props: { children: ReactNode; style?: CSSProperties }): JSX.Element;
