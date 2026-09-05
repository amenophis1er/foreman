/**
 * Local Ollama — where it is, and how to point a project at it.
 *
 * Ollama serves an OpenAI-compatible `/v1`, so it is not a provider kind of
 * its own: it is `openai-compatible` pointed at a daemon. Listing models is
 * every endpoint's business rather than Ollama's alone, so that lives in
 * models.ts; what is genuinely Ollama-specific is only this — the default
 * host, and the zero-config provider for a daemon that is already running.
 */
import { discoverModels, type EndpointModel } from './models.js';
import type { ProviderRef } from './types.js';

/** Where Ollama listens. Honours its own env var rather than assuming a port. */
export function ollamaHost(): string {
  const raw = (process.env.OLLAMA_HOST ?? '').trim();
  if (!raw) return 'http://127.0.0.1:11434';
  // OLLAMA_HOST is commonly set bare ("127.0.0.1:11434", or just a host).
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `http://${raw.replace(/\/+$/, '')}`;
}

/**
 * Models the server's own Ollama offers, or null if none is running.
 *
 * This is the *server default* view, for preflight and the instances screen.
 * A project pinned to another daemon is asked about its own host — see
 * discoverModels().
 */
export function discoverOllama(timeoutMs = 1500): Promise<EndpointModel[] | null> {
  return discoverModels(ollamaHost(), { timeoutMs });
}

/**
 * The provider for an Ollama daemon.
 *
 * `apiKeyEnv` is deliberately absent: a daemon needs no credential — including
 * for `:cloud` models, which it signs for itself with its own key — and the
 * placeholder that satisfies the gateway invariant comes from
 * resolveProvider() rather than being invented here.
 */
export function ollamaProvider(model?: string, host?: string): Extract<ProviderRef, { kind: 'openai-compatible' }> {
  return {
    kind: 'openai-compatible',
    id: 'ollama-local',
    baseUrl: host ?? ollamaHost(),
    label: 'Ollama',
    model,
  };
}
