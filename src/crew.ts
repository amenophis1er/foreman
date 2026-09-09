/**
 * Crew presets, and the reviewer gate that stands between a run and "done".
 *
 * A mission that runs unattended has nobody reading its diff. The director is
 * the same kind of agent as the workers, judging its own homework, and asking
 * it nicely to fetch a second opinion is worth exactly as much as any other
 * instruction in a prompt. So a crew preset — a named role a human opts into
 * at compose time — can be marked `requiredForDone`, and Foreman itself refuses
 * to record the run as done until that reviewer has returned PASS on the diff
 * the run actually ends with.
 *
 * Everything here is pure on purpose: the gate is a rule about a run, not a
 * conversation with a model, and a rule that decides whether work counts as
 * finished has to be provable by a test rather than observed in a log.
 */
import { createHash } from 'node:crypto';
import type { ModelChoice, ToolPolicy } from './types.js';

export type CrewKind = 'reviewer' | 'specialist';

export interface CrewPreset {
  id: string;
  name: string;
  kind: CrewKind;
  model?: ModelChoice;
  providerId?: string;
  brief: string;
  toolPolicy?: 'read-only' | 'default';
  requiredForDone: boolean;
}

/** One reviewer's answer about one diff. `at` is what makes a later one later. */
export interface ReviewVerdict {
  presetId: string;
  name: string;
  pass: boolean;
  findings: string;
  diffHash: string;
  workerId: string;
  costUsd?: number;
  at: number;
}

const REVIEWER_BRIEF = [
  'You are the reviewer on this mission. Review the diff below against MISSION.md and the',
  'mission brief the way a demanding senior engineer reviews a colleague\'s pull request.',
  'Look for correctness first — does this actually do what was asked, and does it break',
  'anything that already worked. Then missing or shallow tests, security, and anything the',
  'DONE WHEN criteria did not name but a careful reader would insist on.',
  'The verdict is PASS only when you would merge this yourself.',
].join(' ');

const SECURITY_BRIEF = [
  'You are the security reviewer on this mission. Review the diff below for the ways this',
  'change could be abused: secrets or tokens committed or logged, injection of any kind',
  '(shell, SQL, HTML, prompt), path handling that can escape its intended root, and',
  'permissions — anything newly reachable without authentication, or granted more access',
  'than the task needs. Ignore style; say plainly what an attacker could do.',
  'The verdict is PASS only when you would ship this yourself.',
].join(' ');

/**
 * The crew a human sees before they have edited anything. Defaults, not law:
 * the moment they change one, their list replaces this one whole.
 *
 * Frozen, and every path out of this module hands back copies, because these
 * objects are shared by every project on the server — a caller that "just"
 * flipped requiredForDone on one would be rewriting the gate for all of them.
 */
export const BUILT_IN_PRESETS: readonly CrewPreset[] = Object.freeze([
  Object.freeze({
    id: 'reviewer',
    name: 'Reviewer',
    kind: 'reviewer' as const,
    model: 'opus',
    toolPolicy: 'read-only' as const,
    requiredForDone: true,
    brief: REVIEWER_BRIEF,
  }),
  Object.freeze({
    id: 'security-review',
    name: 'Security review',
    kind: 'reviewer' as const,
    model: 'opus',
    toolPolicy: 'read-only' as const,
    requiredForDone: false,
    brief: SECURITY_BRIEF,
  }),
]) as readonly CrewPreset[];

/**
 * What "read-only" means for a reviewer: these four tools denied outright, and
 * nothing else configured.
 *
 * The alternative — letting Bash through and classifying each command — is the
 * kind of rule that is right until someone writes `sh -c 'cat > f'`. A flat
 * deny is something a test can prove. It costs the reviewer nothing it needs:
 * AUTO_ALLOW_TOOLS in src/policy.ts already lets Read/Glob/Grep/WebFetch/
 * WebSearch through, and the diff it is judging arrives in its brief, so the
 * only thing it loses is the ability to change the code it is judging.
 */
export const REVIEWER_TOOL_POLICY: ToolPolicy = Object.freeze({
  Write: 'deny',
  Edit: 'deny',
  NotebookEdit: 'deny',
  Bash: 'deny',
}) as ToolPolicy;

function copy(p: CrewPreset): CrewPreset {
  const out: CrewPreset = { id: p.id, name: p.name, kind: p.kind, brief: p.brief, requiredForDone: p.requiredForDone };
  if (p.model) out.model = p.model;
  if (p.providerId) out.providerId = p.providerId;
  if (p.toolPolicy) out.toolPolicy = p.toolPolicy;
  return out;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * A `crewPresets` value read off settings JSON, which nobody validated on the
 * way in. Anything shaped wrongly is dropped rather than repaired: a preset
 * with no id cannot be referenced by a run, and a preset with no name has
 * nothing to put in the sentence that blocks the run.
 *
 * null and [] mean different things, and that difference is why this returns
 * null at all: null is "not configured, fall back", [] is "the human deleted
 * every preset", and answering [] with the built-ins would resurrect a
 * reviewer they had just removed.
 */
export function normalizePresets(raw: unknown): CrewPreset[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CrewPreset[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = nonEmptyString(e.id);
    const name = nonEmptyString(e.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const preset: CrewPreset = {
      id,
      name,
      // A preset of an unknown kind is still a worker with a brief; reviewer is
      // the safe reading, since the only thing kind decides is how it is run.
      kind: e.kind === 'specialist' ? 'specialist' : 'reviewer',
      brief: typeof e.brief === 'string' ? e.brief : '',
      // Anything other than a literal true is not consent to block a run.
      requiredForDone: e.requiredForDone === true,
    };
    const model = nonEmptyString(e.model);
    if (model) preset.model = model;
    const providerId = nonEmptyString(e.providerId);
    if (providerId) preset.providerId = providerId;
    if (e.toolPolicy === 'read-only' || e.toolPolicy === 'default') preset.toolPolicy = e.toolPolicy;
    out.push(preset);
  }
  return out;
}

/**
 * The crew presets in force for a project. A project's list replaces the
 * global one whole rather than merging with it — the same way the rest of
 * Settings overlays — because a merge would make "I removed the reviewer here"
 * unsayable.
 */
export function crewPresetsFrom(global: unknown, project: unknown): CrewPreset[] {
  const read = (blob: unknown): CrewPreset[] | null => {
    if (!blob || typeof blob !== 'object') return null;
    return normalizePresets((blob as Record<string, unknown>).crewPresets);
  };
  return (read(project) ?? read(global) ?? BUILT_IN_PRESETS).map(copy);
}

/**
 * The crew a run starts with, copied onto the run record. Deep copies, because
 * editing a preset next week must not change what a run that is still going —
 * or one that finished in March — was reviewed against.
 */
export function freezeCrew(ids: readonly string[], presets: readonly CrewPreset[]): CrewPreset[] {
  const wanted = new Set(ids);
  const taken = new Set<string>();
  const out: CrewPreset[] = [];
  for (const p of presets) {
    if (!wanted.has(p.id) || taken.has(p.id)) continue;
    taken.add(p.id);
    out.push(copy(p));
  }
  return out;
}

/** Past this, findings are a wall of text nobody reads and a row nobody wants to store. */
const MAX_FINDINGS = 8000;

/**
 * The reviewer's verdict, dug out of its report. It is told to end with a line
 * that is exactly `VERDICT: PASS` or `VERDICT: FAIL`; the last such line wins,
 * because a report that quotes the format while explaining itself and then
 * states its verdict at the end has stated it at the end.
 *
 * null is not FAIL. A report that never says either has not been reviewed —
 * the model ran out of turns, or answered in prose — and the caller has to be
 * able to tell that apart from a reviewer that looked and said no.
 */
export function parseVerdict(report: string): { pass: boolean; findings: string } | null {
  if (typeof report !== 'string' || report === '') return null;
  const lines = report.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Markdown decoration is what a model reaches for when told to make a line
    // stand out; `**VERDICT: PASS**` is the instruction followed, not broken.
    const line = lines[i].replace(/\*\*/g, '').replace(/^\s*#+\s*/, '');
    const m = /^\s*VERDICT:\s*(PASS|FAIL)\s*$/i.exec(line);
    if (!m) continue;
    let findings = lines.slice(i + 1).join('\n').trim();
    if (findings.length > MAX_FINDINGS) {
      findings = findings.slice(0, MAX_FINDINGS) + '\n\n[findings truncated]';
    }
    return { pass: m[1].toUpperCase() === 'PASS', findings };
  }
  return null;
}

/**
 * A fingerprint of what a run has changed, so a PASS can be pinned to the diff
 * it was given. Canonical: sorted by path and field-separated, so the same
 * files listed in a different order are the same hash, while one changed line
 * anywhere is a different one.
 */
export function diffHash(deck: {
  files?: Array<{ path: string; status: string; additions: number; deletions: number; diff?: string }>;
}): string {
  const files = deck?.files ?? [];
  const canon = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => [f.path, f.status, f.additions, f.deletions, f.diff ?? ''].join('\0'))
    .join('\n');
  // A run that changed nothing still has a stable hash, so "reviewed, then
  // nothing moved" holds for an empty diff too.
  return createHash('sha256').update(canon).digest('hex');
}

export interface ReviewBlocker {
  presetId: string;
  name: string;
  reason: 'missing' | 'fail' | 'stale';
}

/**
 * THE GATE. Every required reviewer that has not passed the run's current
 * diff, in crew order. An empty array is the only thing that lets a run be
 * recorded as done.
 *
 * 'stale' is the case worth the machinery: a reviewer passed, then the
 * director kept working. That PASS was about code that no longer exists, and
 * treating it as consent for whatever came afterwards would make the gate
 * trivially walk-around-able — review early, then commit anything.
 */
export function reviewBlockers(
  crew: readonly CrewPreset[] | undefined,
  verdicts: readonly ReviewVerdict[] | undefined,
  currentDiffHash: string,
): ReviewBlocker[] {
  const out: ReviewBlocker[] = [];
  for (const preset of crew ?? []) {
    if (preset.requiredForDone !== true) continue;
    // Latest by `at`, ties going to the one that arrived later in the array —
    // two verdicts written in the same millisecond are in the order they were
    // appended.
    let latest: ReviewVerdict | undefined;
    for (const v of verdicts ?? []) {
      if (v.presetId !== preset.id) continue;
      if (!latest || v.at >= latest.at) latest = v;
    }
    if (!latest) out.push({ presetId: preset.id, name: preset.name, reason: 'missing' });
    else if (!latest.pass) out.push({ presetId: preset.id, name: preset.name, reason: 'fail' });
    else if (latest.diffHash !== currentDiffHash) out.push({ presetId: preset.id, name: preset.name, reason: 'stale' });
  }
  return out;
}

/** One human sentence for the `mission_unreviewed` event. */
export function unreviewedText(blockers: readonly ReviewBlocker[]): string {
  if (!blockers.length) return '';
  const clause = (b: ReviewBlocker): string => {
    if (b.reason === 'fail') return `${b.name} returned FAIL`;
    if (b.reason === 'stale') return `${b.name} passed an earlier version of the diff; the code changed after it`;
    return `${b.name} has not reviewed this run`;
  };
  const parts = blockers.map(clause);
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
  const lead = blockers.length === 1 ? 'A required reviewer has not passed this run' : 'Required reviewers have not passed this run';
  return `${lead}: ${list}. This run is not done. Resume to continue it.`;
}

/**
 * The prompt the reviewer worker is started with. The diff is handed over in
 * the brief rather than left to be discovered, because a read-only worker with
 * no Bash cannot run `git diff` for itself — and because the thing being
 * reviewed should be the thing Foreman will hash, not whatever the model
 * happened to look at.
 */
export function reviewBriefFor(
  preset: CrewPreset,
  opts: { mission: string; doneWhen: string; diff: string; truncated: boolean },
): string {
  const parts: string[] = [preset.brief.trim()];
  parts.push(`## The mission\n\n${opts.mission.trim() || '(no brief was recorded)'}`);
  parts.push(`## DONE WHEN\n\n${opts.doneWhen.trim() || '(no criteria were recorded)'}`);
  parts.push(`## The diff\n\n\`\`\`diff\n${opts.diff}\n\`\`\``);
  if (opts.truncated) {
    parts.push(
      'That diff was cut short because it is large. Read the files you need directly — ' +
      'Read, Glob and Grep are available to you.',
    );
  }
  parts.push(
    'You cannot modify files: Write, Edit and Bash are denied to you, and attempting them ' +
    'wastes the run. Report, do not fix.',
  );
  parts.push(
    'End your report with a line that is exactly `VERDICT: PASS` or `VERDICT: FAIL`, and ' +
    'then list your findings under it, each with a `file:line` where you can give one. ' +
    'Only what follows that line is kept as your findings.',
  );
  return parts.join('\n\n');
}
