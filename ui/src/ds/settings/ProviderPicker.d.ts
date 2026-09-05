import type { CSSProperties } from 'react';

export type ProviderRef =
  | { kind: 'claude-code'; configDir?: string; executable?: string; ownLogin?: boolean }
  | { kind: 'anthropic-api'; id?: string; apiKeyEnv: string; model?: string }
  | { kind: 'codex'; id?: string; codexHome?: string; upstreamUrl?: string; model?: string }
  | { kind: 'openai-compatible'; id?: string; baseUrl: string; apiKeyEnv?: string; label?: string; model?: string };

/** One Claude Code install found on disk, as `GET /instances` reports it. */
export interface DiscoveredInstance {
  configDir: string;
  origin: 'server default' | 'this process' | 'found on disk';
  hasStoredLogin: boolean;
}

/** A local Ollama daemon, as `GET /instances` reports it. `null`/absent means none was found. */
export interface OllamaInfo {
  host: string;
  models: { id: string; size?: string; remote: boolean; host?: string }[];
}

/**
 * Edits one `ProviderRef` — engine, credential and wire as a single choice.
 * A segmented kind switch, then only the fields that kind takes; changing
 * kind replaces the value rather than merging fields across kinds, so the
 * union can never express a combination it forbids (e.g. subscription login
 * with a custom base URL).
 */
export interface ProviderPickerProps {
  /** `null` (or omitted) is the server default — no project pin. */
  value?: ProviderRef | null;
  /** Fires with the full replacement value, or `null` to clear the pin. */
  onChange: (next: ProviderRef | null) => void;
  /** Discovered Claude Code installs, offered as one-click choices ahead of
   *  free-text entry. From `GET /instances` → `.instances`. */
  instances?: DiscoveredInstance[];
  /** A running local Ollama daemon, offered as a one-click custom-endpoint
   *  choice. From `GET /instances` → `.ollama` (absent/null when none is running). */
  ollama?: OllamaInfo | null;
  style?: CSSProperties;
}

export declare function ProviderPicker(props: ProviderPickerProps): JSX.Element;
