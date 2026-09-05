import type { CSSProperties } from 'react';

/** `GET /notify` — status only. The token is never part of it. */
export interface NotifyStatus {
  publicUrl: string;
  prefs: { needsYou: boolean; done: boolean; budget: boolean };
  /** Names of attached channels, e.g. ['telegram']. */
  active: string[];
  delivered: number;
  failures: number;
  telegram: {
    hasToken: boolean;
    /** The bot's @username once a token was validated. */
    bot: string | null;
    /** Masked: the last four digits only. */
    chatId: string | null;
    chatLabel: string | null;
    /**
     * A linking attempt in progress: the code to send to the bot, and the
     * `t.me/<bot>?start=<code>` deep link that pre-fills it. The panel renders
     * the link as a QR (`GET /notify/telegram/qr.svg`) and as an anchor.
     */
    linking: { code: string; startedAt: number; deepLink?: string } | null;
  };
}

/**
 * The Telegram section of Settings → Notifications (global scope only).
 *
 * Presentational: state and calls live in `useNotify()` in state.ts. The
 * token is write-only end to end — this panel can say one exists and never
 * shows it — and linking is a one-time code the human sends to their own bot,
 * so no OAuth is reimplemented and no public URL is required.
 */
export interface NotifyPanelProps {
  status: NotifyStatus | null;
  busy?: boolean;
  error?: string;
  onSaveToken?: (token: string) => void;
  onClearToken?: () => void;
  /** Starts (or restarts) a linking attempt; the code appears in `status.telegram.linking`. */
  onLink?: () => void;
  onUnlink?: () => void;
  onTest?: () => void;
  onSavePublicUrl?: (url: string) => void;
  style?: CSSProperties;
}

export declare function NotifyPanel(props: NotifyPanelProps): JSX.Element;
