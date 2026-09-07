/**
 * A role's provider, checked against its model at dispatch.
 *
 * A run carries, per role, a model and the provider that serves it. The two
 * are picked together in every picker, but they travel separately — through
 * settings files, drafts, older builds and resumes — and once they drift a
 * mission fails on its first turn with an upstream 400 nobody chose: the
 * Claude alias `fable` sent through the Codex gateway, say, which then
 * answers that the model "is not supported when using Codex". Nothing was
 * checking that the provider actually serves the model.
 *
 * This is that check. The model list is the authority: a model the machine
 * offers is served by whichever provider lists it, and a role is corrected
 * to that provider whatever it arrived with. A model the list does not know
 * is left alone, except for the one pairing that can never work: an
 * Anthropic model on a provider that only serves its own catalogue.
 */
import { ANTHROPIC_ALIASES } from './anthropic-models.js';

export interface KnownModel {
  id: string;
  /** Absent means the project's own provider (Anthropic by default). */
  providerId?: string;
}

/** Providers that serve exactly the models they list and nothing else. */
const CLOSED_PROVIDERS = new Set(['codex-local', 'ollama-local']);

export interface Reconciled {
  providerId?: string;
  /** Set when the pairing had to change; one sentence, for the transcript. */
  note?: string;
}

const isAnthropic = (model: string) => ANTHROPIC_ALIASES.has(model) || /^claude-/i.test(model);

/**
 * The provider a role should run on, given what it was handed and what the
 * machine offers. Returns the same provider id and no note when nothing is
 * wrong, which is the common case.
 */
export function reconcileRole(
  role: 'director' | 'workers', model: string | undefined, providerId: string | undefined, models: KnownModel[],
): Reconciled {
  const given = providerId?.trim() || undefined;
  // No model means "inherit the project's default", which lives on the
  // project's provider. A provider id left behind without a model is stale.
  if (!model) {
    return given ? { providerId: undefined, note: `${role}: no model was chosen, so the ${given} provider pin was dropped.` } : { providerId: undefined };
  }
  const want = model.trim().toLowerCase();
  const known = models.find((m) => m.id.toLowerCase() === want);
  if (known) {
    const served = known.providerId || undefined;
    if (served === given) return { providerId: given };
    return {
      providerId: served,
      note: `${role}: ${model} is served by ${served ?? 'the project\'s provider'}, not ${given ?? 'the project\'s provider'}; corrected.`,
    };
  }
  if (given && CLOSED_PROVIDERS.has(given) && isAnthropic(model)) {
    return { providerId: undefined, note: `${role}: ${model} is an Anthropic model and ${given} cannot serve it; running it on the project's provider instead.` };
  }
  return { providerId: given };
}
