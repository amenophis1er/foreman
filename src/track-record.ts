/**
 * What the run ledger says, read back: how models have done here, and what
 * missions in a project have cost. Foreman already keeps every run's model,
 * outcome, spend and crew; nobody was reading it. This is the safe kind of
 * learning — statistics, deterministic and explainable — and it feeds three
 * places without any agent writing anything: the planner's budget anchor,
 * the model picker's second line, and the front desk's reports.
 */
import type { RunMeta } from './types.js';

/** A model's record in one role. */
export interface ModelRecord {
  model: string;
  /** As director: runs and how they ended. */
  runs: number;
  done: number;
  interrupted: number;
  error: number;
  /** Median priced spend of done runs; undefined when nothing was priced. */
  medianCostUsd?: number;
  /** Median wall clock of done runs, in minutes. */
  medianMinutes?: number;
  /** As worker: workers spawned on it and how they ended. */
  workers: number;
  workersDone: number;
  workersFailed: number;
}

/** A project's record. */
export interface ProjectRecord {
  runs: number;
  done: number;
  /** Priced spend of done runs, low and high (interquartile-ish: 25th and 75th). */
  costLowUsd?: number;
  costHighUsd?: number;
  medianCostUsd?: number;
  medianMinutes?: number;
  /** Done runs that ended within 5% of their cap. */
  capHits: number;
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];
};
const finished = (r: RunMeta) => r.status !== 'running';
const priced = (r: RunMeta) => r.costBasis === 'priced' || (r.costBasis === undefined && r.metered !== false);
const minutes = (r: RunMeta) => (typeof r.endedAt === 'number' && typeof r.createdAt === 'number' ? (r.endedAt - r.createdAt) / 60_000 : undefined);

/** Every model's record across the runs given, keyed by model id. */
export function modelRecords(runs: RunMeta[]): Map<string, ModelRecord> {
  const out = new Map<string, ModelRecord>();
  const get = (model: string) => {
    let r = out.get(model);
    if (!r) { r = { model, runs: 0, done: 0, interrupted: 0, error: 0, workers: 0, workersDone: 0, workersFailed: 0 }; out.set(model, r); }
    return r;
  };
  const costs = new Map<string, number[]>();
  const mins = new Map<string, number[]>();
  for (const run of runs) {
    if (!finished(run)) continue;
    const d = run.directorModel ? String(run.directorModel) : undefined;
    if (d) {
      const r = get(d);
      r.runs += 1;
      if (run.status === 'done') {
        r.done += 1;
        if (priced(run)) costs.set(d, [...(costs.get(d) ?? []), run.costUsd]);
        const m = minutes(run);
        if (m !== undefined) mins.set(d, [...(mins.get(d) ?? []), m]);
      } else if (run.status === 'interrupted') r.interrupted += 1;
      else if (run.status === 'error') r.error += 1;
    }
    const w = run.workerModel ? String(run.workerModel) : undefined;
    if (w) {
      const r = get(w);
      for (const wk of run.workers ?? []) {
        if (wk.status === 'running') continue;
        r.workers += 1;
        if (wk.status === 'done' && !wk.isError) r.workersDone += 1; else r.workersFailed += 1;
      }
    }
  }
  for (const [model, r] of out) {
    r.medianCostUsd = median(costs.get(model) ?? []);
    const mm = median(mins.get(model) ?? []);
    r.medianMinutes = mm === undefined ? undefined : Math.round(mm);
  }
  return out;
}

/** One project's record from its runs. */
export function projectRecord(runs: RunMeta[]): ProjectRecord {
  const fin = runs.filter(finished);
  const done = fin.filter((r) => r.status === 'done');
  const costs = done.filter(priced).map((r) => r.costUsd);
  const mins = done.map(minutes).filter((m): m is number => m !== undefined);
  const mm = median(mins);
  return {
    runs: fin.length, done: done.length,
    costLowUsd: quantile(costs, 0.25), costHighUsd: quantile(costs, 0.75), medianCostUsd: median(costs),
    medianMinutes: mm === undefined ? undefined : Math.round(mm),
    capHits: done.filter((r) => priced(r) && r.budgetUsd > 0 && r.costUsd >= r.budgetUsd * 0.95).length,
  };
}

const usd = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)}`;

/** The picker's second line for a model, or undefined when there is nothing to say yet. */
export function recordLine(r: ModelRecord | undefined): string | undefined {
  if (!r || (r.runs === 0 && r.workers === 0)) return undefined;
  const bits: string[] = [];
  if (r.runs > 0) {
    let s = `director ${r.done}/${r.runs} done`;
    const extras = [r.medianCostUsd !== undefined ? `~${usd(r.medianCostUsd)}` : null, r.medianMinutes !== undefined ? `~${r.medianMinutes} min` : null].filter(Boolean);
    if (extras.length) s += ` (${extras.join(', ')})`;
    bits.push(s);
  }
  if (r.workers > 0) bits.push(`workers ${r.workersDone}/${r.workers} finished`);
  return `here: ${bits.join(' · ')}`;
}

/**
 * The planner's budget anchor from history, replacing the generic ladder
 * when a project (or the fleet) has enough finished missions to say
 * something. Returns '' when there is nothing worth anchoring on.
 */
export function budgetAnchor(project: ProjectRecord, fleet: ProjectRecord, projectName?: string): string {
  const lines: string[] = [];
  const fmt = (p: ProjectRecord) => {
    if (p.medianCostUsd === undefined) return null;
    const range = p.costLowUsd !== undefined && p.costHighUsd !== undefined && p.costHighUsd > p.costLowUsd
      ? `${usd(p.costLowUsd)}–${usd(p.costHighUsd)} (median ${usd(p.medianCostUsd)})` : `about ${usd(p.medianCostUsd)}`;
    return `${range}${p.medianMinutes !== undefined ? `, ~${p.medianMinutes} min` : ''}, over ${p.done} finished mission${p.done === 1 ? '' : 's'}${p.capHits ? `; ${p.capHits} ended within 5% of the cap` : ''}`;
  };
  const pj = project.done >= 2 ? fmt(project) : null;
  const fl = fleet.done >= 3 ? fmt(fleet) : null;
  if (pj) lines.push(`In ${projectName ? `"${projectName}"` : 'this project'}, finished missions cost ${pj}.`);
  if (fl && (!pj || fleet.done > project.done)) lines.push(`Across the fleet: ${fl}.`);
  if (!lines.length) return '';
  return `\nWHAT MISSIONS HAVE COST (from Foreman's own records — use these to anchor the budget before the generic ladder):\n  ${lines.join('\n  ')}\n  A cap that was hit is a mission that ran out, not one that fit; anchor above it, not on it.\n`;
}
