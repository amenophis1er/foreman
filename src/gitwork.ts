/**
 * Git around a mission: which branch a folder is on, a branch of its own for
 * each mission, and the commit that closes one.
 *
 * A mission is a unit of work; in a repository, a branch makes it one in
 * git too — isolation, a diff that is exactly the mission, an easy revert,
 * a pull request if there is a remote. Foreman creates the branch and
 * commits on it. It never merges and never pushes: those stay the human's.
 */
import { execFile } from 'node:child_process';

export interface GitInfo {
  repo: boolean;
  /** Current branch; a short sha when detached. */
  branch?: string;
  /** Uncommitted changes, tracked or untracked. */
  dirty?: boolean;
  head?: string | null;
  /** `origin`'s URL when there is one, so the UI can say "has a remote". */
  remote?: string;
}

/** Recorded on a run that got a branch of its own. */
export interface MissionGit {
  branch: string;
  /** Where it was made from: the branch (or short sha) that was checked out. */
  base: string;
  baseHead: string | null;
  /** Commits on the branch since `baseHead`, updated when the mission closes. */
  commits?: number;
  /** The closing commit, when the mission's work was committed. */
  commit?: string;
}

function git(args: string[], cwd: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
  });
}

/** What git says about a folder; `{ repo: false }` for anything that is not a work tree. Never throws. */
export async function gitInfo(folder: string): Promise<GitInfo> {
  try {
    const inside = (await git(['rev-parse', '--is-inside-work-tree'], folder)).trim();
    if (inside !== 'true') return { repo: false };
  } catch {
    return { repo: false };
  }
  const info: GitInfo = { repo: true };
  try {
    const ref = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], folder)).trim();
    info.branch = ref === 'HEAD' ? (await git(['rev-parse', '--short', 'HEAD'], folder)).trim() : ref;
  } catch {
    // An empty repository: HEAD names a branch with no commits yet.
    try { info.branch = (await git(['symbolic-ref', '--short', 'HEAD'], folder)).trim(); } catch { /* leave unset */ }
  }
  try { info.head = (await git(['rev-parse', '--verify', 'HEAD'], folder)).trim() || null; } catch { info.head = null; }
  try { info.dirty = (await git(['status', '--porcelain', '--untracked-files=normal'], folder)).trim().length > 0; } catch { /* unknown */ }
  try { info.remote = (await git(['remote', 'get-url', 'origin'], folder)).trim() || undefined; } catch { /* no remote */ }
  return info;
}

/** `foreman/<first words of the brief>-<id tail>`: readable in `git branch`, unique per run. */
export function missionBranchName(mission: string, runId: string): string {
  const first = mission.split('\n').find((l) => l.trim())?.trim() ?? 'mission';
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 6).join('-').slice(0, 40).replace(/-+$/, '') || 'mission';
  const tail = runId.replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase();
  return `foreman/${slug}-${tail}`;
}

/**
 * A branch of the mission's own, made from what is checked out now.
 * Uncommitted changes come along, as `checkout -b` always does. Resolves to
 * the record for the run, or to one sentence on why it could not.
 */
export async function startMissionBranch(folder: string, mission: string, runId: string): Promise<MissionGit | { error: string }> {
  const info = await gitInfo(folder);
  if (!info.repo) return { error: 'not a git repository' };
  const branch = missionBranchName(mission, runId);
  try {
    await git(['checkout', '-b', branch], folder);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { branch, base: info.branch ?? 'HEAD', baseHead: info.head ?? null };
}

/**
 * Back on the mission's branch for a resume. Returns null when already or
 * now there, else why not — a dirty tree that would be clobbered, typically.
 */
export async function ensureMissionBranch(folder: string, branch: string): Promise<string | null> {
  const info = await gitInfo(folder);
  if (!info.repo) return 'the folder is no longer a git repository';
  if (info.branch === branch) return null;
  try {
    await git(['checkout', branch], folder);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Commits whatever the mission left uncommitted, on its branch, as the user
 * (their git config), falling back to a Foreman identity only when the
 * repository has none. Then counts the branch's commits since its base.
 */
export async function closeMissionBranch(folder: string, g: MissionGit, message: string): Promise<MissionGit & { committed: boolean; error?: string }> {
  const out: MissionGit & { committed: boolean; error?: string } = { ...g, committed: false };
  try {
    const info = await gitInfo(folder);
    if (!info.repo) return { ...out, error: 'not a git repository' };
    if (info.branch !== g.branch) return { ...out, error: `the folder is on ${info.branch ?? 'another branch'}, not ${g.branch}; nothing committed` };
    if (info.dirty) {
      await git(['add', '-A', '--', '.'], folder);
      const identity = ['-c', 'user.name=Foreman', '-c', 'user.email=foreman@localhost'];
      const hasName = await git(['config', 'user.name'], folder).then((v) => v.trim().length > 0).catch(() => false);
      await git([...(hasName ? [] : identity), 'commit', '-q', '-m', message], folder);
      out.commit = (await git(['rev-parse', '--short', 'HEAD'], folder)).trim();
      out.committed = true;
    }
    if (g.baseHead) {
      out.commits = Number((await git(['rev-list', '--count', `${g.baseHead}..HEAD`], folder)).trim()) || 0;
    } else {
      out.commits = Number((await git(['rev-list', '--count', 'HEAD'], folder)).trim()) || 0;
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}
