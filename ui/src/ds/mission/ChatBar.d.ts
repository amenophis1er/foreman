import type { CSSProperties } from 'react';

/**
 * The input for a project's planning conversation — the talk that happens before a mission exists.
 * Docked under the planning transcript, sharing SteerBar's shell without its recipient and timing controls:
 * there is one listener, and nothing running to interrupt.
 */
export interface ChatBarProps {
  /** Controlled draft text. Omit to let the bar hold its own draft. */
  value?: string;
  onChange?: (v: string) => void;
  /** Fires on Send / ⌘↵ with the trimmed text. */
  onSend?: (text: string) => void;
  /** A turn is in flight: the icon pulses and Send is held until the reply lands. */
  busy?: boolean;
  /** Planning is unavailable (a mission is running — steer the director instead). */
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  style?: CSSProperties;
}

export declare function ChatBar(props: ChatBarProps): JSX.Element;
