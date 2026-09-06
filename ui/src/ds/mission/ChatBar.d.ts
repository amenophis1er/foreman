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
  /** Text and the files picked, dropped or pasted since the last send. Files alone send with a stand-in line. */
  onSend?: (text: string, files: File[]) => void;
  /** A turn is in flight: the icon pulses and Send is held until the reply lands. */
  busy?: boolean;
  /** While `busy`, Send becomes Stop and calls this. */
  onStop?: () => void;
  /** Focus the input on mount — for an empty state where the input is the page. */
  autoFocus?: boolean;
  /** Planning is unavailable (a mission is running — steer the director instead). */
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  /**
   * Who is answering: the planner's model and the provider serving it, with
   * its cost basis. Rendered in the footer on every state of the bar, because
   * a conversation that never said which model was talking left the human
   * unable to tell Sonnet on their subscription from a local model through a
   * gateway — which decides both the quality of the advice and who pays.
   */
  who?: { model: string; provider: string; costBasis: 'priced' | 'free' | 'unpriced' } | null;
  /** When given, the model name in the footer is a link that opens where it can be changed. */
  onChangeModel?: () => void;
  style?: CSSProperties;
}

export declare function ChatBar(props: ChatBarProps): JSX.Element;
