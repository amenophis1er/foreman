import type { CSSProperties } from 'react';
import type { BillingMode } from '../status/BillingBadge';
import type { SettingsSectionId } from '../settings/SettingsModal';

/** The thin status line at the foot of every screen: connection, reachability, phone, payer, version. Clicks open Settings sections. */
export interface StatusBarProps {
  connected: boolean;
  /** `http://localhost:4177` — where this tab is talking to. */
  localUrl: string;
  /** The server's public URL when it differs (the tailnet name, https when served). */
  publicUrl?: string | null;
  /** Linked Telegram chat label; null when none; undefined while unknown. */
  phone?: string | null;
  auth?: { mode: BillingMode; source: string; account?: { email?: string; org?: string } };
  version?: string;
  update?: { latest: string; current: string } | null;
  onOpenSettings?: (section: SettingsSectionId) => void;
  style?: CSSProperties;
}

export declare function StatusBar(props: StatusBarProps): JSX.Element;
