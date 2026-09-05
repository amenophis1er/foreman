/**
 * Local Ollama discovery.
 *
 * Ollama serves an OpenAI-compatible `/v1`, so it is not a provider kind of
 * its own — it is `openai-compatible` pointed at a loopback port. This module
 * only answers "is one running, and what has it pulled", which is the same
 * question `discoverInstances()` answers for Claude Code installs.
 *
 * The goal is zero configuration: if Ollama is up when Foreman starts, its
 * models appear in the picker and a mission can run on one without anybody
 * typing a URL.
 */
import type { ProviderRef } from './types.js';

/** Where Ollama listens. Honours its own env var rather than assuming a port. */
export function ollamaHost(): string {
  const raw = (process.env.OLLAMA_HOST ?? '').trim();
  if (!raw) return 'http://127.0.0.1:11434';
  // OLLAMA_HOST is commonly set bare ("127.0.0.1:11434", or just a host).
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/\/+$/, '')}`;
}

export interface OllamaModel {
  /** Exactly what the API expects as a model id, e.g. `qwen3.8:27b-q8_0`. */
  id: string;
  /** Parameter count as Ollama reports it; absent for some remote models. */
  size?: string;
  /**
   * A `:cloud` model, which runs on Ollama's servers rather than this machine.
   * Worth distinguishing: it is neither free nor private, and Foreman's budget
   * story for local models does not apply to it.
   */
  remote: boolean;
}

/**
 * Models a running Ollama has available, or null if none is running.
 *
 * Never throws and never waits long: this runs during preflight, and a machine
 * without Ollama is the common case, not an error.
 */
export async function discoverOllama(timeoutMs = 1500): Promise<OllamaModel[] | null> {
  const host = ollamaHost();
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${host}/api/tags`, { signal: ctl }).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null) as {
    models?: Array<{ name?: string; remote_model?: string; details?: { parameter_size?: string } }>;
  } | null;
  if (!body?.models) return null;
  return body.models
    .filter((m): m is { name: string } & typeof m => typeof m.name === 'string' && m.name.length > 0)
    .map((m) => ({
      id: m.name,
      size: m.details?.parameter_size || undefined,
      remote: Boolean(m.remote_model),
    }))
    .sort((a, b) => Number(a.remote) - Number(b.remote) || a.id.localeCompare(b.id));
}

/**
 * The provider for a discovered local Ollama.
 *
 * `apiKeyEnv` is deliberately absent: a local Ollama needs no credential, and
 * the placeholder that satisfies the gateway invariant is supplied by
 * resolveProvider() rather than invented here.
 */
export function ollamaProvider(model?: string): ProviderRef {
  return {
    kind: 'openai-compatible',
    id: 'ollama-local',
    baseUrl: ollamaHost(),
    label: 'Ollama',
    model,
  };
}
