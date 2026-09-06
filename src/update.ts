/**
 * "Is there a newer Foreman?" — asked of the npm registry, answered quietly.
 *
 * Read-only and best-effort: a registry that does not answer within the
 * timeout means "unknown", never an error, and nothing here ever installs
 * anything. Installing is `foreman update`'s job, on purpose and by hand;
 * Foreman runs agents on your files while you are away, and it must never
 * change under a running mission without a human's hand.
 */
import { readFileSync } from 'node:fs';

export const PACKAGE = '@amenophis1er/foreman';

export interface UpdateInfo {
  current: string;
  latest: string;
  /** `latest` is strictly newer than `current`. */
  newer: boolean;
}

/** `1.2.3` vs `1.10.0` the numeric way; a pre-release tag sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ?? '' };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;   // release > pre-release
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/** The version of the package this code runs from. */
export function currentVersion(pkgUrl = new URL('../package.json', import.meta.url)): string {
  try { return String(JSON.parse(readFileSync(pkgUrl, 'utf8')).version ?? '0.0.0'); } catch { return '0.0.0'; }
}

/** The registry's `latest` tag, or null when it cannot be reached in time. */
export async function latestVersion(pkg = PACKAGE, timeoutMs = 2_500, registry = 'https://registry.npmjs.org'): Promise<string | null> {
  try {
    const r = await fetch(`${registry}/${encodeURIComponent(pkg).replace('%40', '@')}/latest`, {
      signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' },
    });
    if (!r.ok) return null;
    const d = await r.json() as { version?: string };
    return typeof d.version === 'string' ? d.version : null;
  } catch { return null; }
}

/** Current vs latest, or null when the registry did not answer. */
export async function checkForUpdate(current = currentVersion(), timeoutMs?: number): Promise<UpdateInfo | null> {
  const latest = await latestVersion(PACKAGE, timeoutMs);
  if (!latest) return null;
  return { current, latest, newer: compareVersions(latest, current) > 0 };
}
