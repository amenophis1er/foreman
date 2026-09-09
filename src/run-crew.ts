/**
 * The crew as a *run* sees it: what gets frozen onto the record at dispatch,
 * and how the verdicts it collected read back in a report.
 *
 * Both halves are here rather than in crew.ts because crew.ts is the rules —
 * what a preset is, and what blocks a run — while these are the two places
 * Foreman's own surfaces touch them: server.ts freezing at dispatch, and
 * server.ts and mcp.ts writing the same lines to the phone and to MCP. Two
 * surfaces printing verdicts two different ways is how "PASS" comes to mean
 * something slightly different depending on where you read it.
 */
import { freezeCrew, reviewBlockers, type CrewPreset, type ReviewVerdict } from './crew.js';

/**
 * The crew to freeze onto a new run, or undefined when there is none.
 *
 * undefined rather than [] on purpose: an absent field is how every run
 * recorded before presets existed reads, and a run dispatched with no crew is
 * that same run. Unknown ids fall away silently — freezeCrew resolves against
 * the presets actually in force, so an id from a preset the human has since
 * deleted cannot conjure a reviewer that no longer exists.
 */
export function frozenCrewFor(
  presets: readonly CrewPreset[],
  ids: readonly string[] | undefined,
): CrewPreset[] | undefined {
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  const clean = ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  const crew = freezeCrew(clean, presets);
  return crew.length ? crew : undefined;
}

/**
 * The reviewers whose PASS this finished run is entitled to wear, or [] .
 *
 * Derived here and sent as a name list rather than shipping `reviews` into the
 * fleet's projection, because that projection exists to stay small: it is
 * re-polled every few seconds for every project, and a verdict's findings run
 * to thousands of characters that a tile never renders. The tile asks one
 * question — "did the required reviewers pass?" — so it is handed the answer.
 *
 * Only a run Foreman actually recorded `done` qualifies, and that is what
 * makes staleness answerable from a record alone: the end-of-run gate refuses
 * `done` unless every required PASS was pinned to the diff the run ended with,
 * so a `done` run with all its required verdicts passing was current when it
 * mattered. Anything else gets no mark rather than a mark that might be a lie.
 */
export function reviewedByNames(run: {
  status: string;
  crew?: readonly CrewPreset[];
  reviews?: readonly ReviewVerdict[];
}): string[] {
  if (run.status !== 'done') return [];
  const required = (run.crew ?? []).filter((p) => p.requiredForDone);
  if (!required.length) return [];
  const names: string[] = [];
  for (const p of required) {
    const passed = (run.reviews ?? []).filter((v) => v.presetId === p.id && v.pass);
    if (!passed.length) return [];
    names.push(p.name);
  }
  return names;
}

/** `$0.42` when the run's provider priced it, nothing when it did not. */
function cost(v: ReviewVerdict): string {
  return typeof v.costUsd === 'number' && v.costUsd > 0 ? ` · $${v.costUsd.toFixed(2)}` : '';
}

/**
 * The `reviews:` block for a run report, or [] when the run collected none.
 *
 * `currentDiffHash` is optional because most surfaces cannot honestly compute
 * it: a report reads a frozen deck whose diffs are capped, so hashing it would
 * call a perfectly good PASS stale. Without it, staleness is simply not
 * claimed — the end-of-run gate is the one place that judges it — and the
 * other two blockers, a required reviewer that never ran and one that said
 * FAIL, are facts the record already holds.
 */
export function reviewReportLines(
  crew: readonly CrewPreset[] | undefined,
  reviews: readonly ReviewVerdict[] | undefined,
  currentDiffHash?: string,
): string[] {
  const verdicts = reviews ?? [];
  if (!verdicts.length && !(crew ?? []).length) return [];
  const lines: string[] = [];
  if (verdicts.length) {
    lines.push(`reviews: ${verdicts.map((v) => `${v.name} ${v.pass ? 'PASS' : 'FAIL'}${cost(v)}`).join(', ')}`);
  }
  const blockers = reviewBlockers(crew, verdicts, currentDiffHash ?? '')
    .filter((b) => (currentDiffHash === undefined ? b.reason !== 'stale' : true));
  for (const b of blockers) {
    lines.push(b.reason === 'missing'
      ? `  ${b.name} is required for this run to be done and has not reviewed it.`
      : b.reason === 'fail'
        ? `  ${b.name} is required for this run to be done and returned FAIL.`
        : `  ${b.name} passed an earlier version of the diff; the code changed after it.`);
  }
  return lines;
}
