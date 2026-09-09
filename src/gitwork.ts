/**
 * Git around a mission: which branch a folder is on, a branch of its own for
 * each mission, and the commit that closes one.
 *
 * A mission is a unit of work; in a repository, a branch makes it one in
 * git too — isolation, a diff that is exactly the mission, an easy revert,
 * a pull request if there is a remote. Foreman creates the branch and
 * commits on it. It never merges, and it pushes only when the human presses
 * the button that says so — once, for that branch, to open the pull request.
 */
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { ReviewVerdict } from './crew.js';

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
  // Whole words up to six and forty characters: a name cut mid-word
  // ("null-handli") reads worse than a shorter one.
  const words = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 6);
  let slug = '';
  for (const w of words) { const next = slug ? `${slug}-${w}` : w; if (next.length > 40) break; slug = next; }
  slug = slug || words[0]?.slice(0, 40) || 'mission';
  const tail = runId.replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase();
  return `foreman/${slug}-${tail}`;
}

/**
 * A branch of the mission's own, made from what is checked out now.
 * Uncommitted changes come along, as `checkout -b` always does. Resolves to
 * the record for the run, or to one sentence on why it could not.
 */
/**
 * The paths with uncommitted changes, tracked or untracked, capped for a
 * message. `checkout -b` carries all of them onto the mission's branch, and
 * the closing commit sweeps whatever is still uncommitted into the mission's
 * own commit — so this is what a human stands to have committed under a
 * mission's name without noticing.
 */
/**
 * When this folder is a linked git worktree, the repository it was made from:
 * the main worktree's root. Null when the folder is that main worktree, is
 * not a repository, or git is too old to say.
 *
 * Worktrees are the reason a mission asks the human the same question all
 * day. A worktree holds a branch's files but not the repository's shared
 * scaffolding — the build config, the type declarations, the parent package's
 * node_modules — so a crew working in one steps up to the parent constantly,
 * and every step is a boundary crossing.
 */
export interface WorktreeShape {
  /** The main worktree's root: the repository this folder was made from. */
  parent: string;
  /** Every other worktree of the same repository, this folder excluded. */
  siblings: string[];
}

export async function worktreeParent(folder: string): Promise<WorktreeShape | null> {
  try {
    const out = await git(['worktree', 'list', '--porcelain'], folder);
    // The first entry is always the main worktree; the rest are the linked ones.
    const roots = out.split('\n').filter((l) => l.startsWith('worktree '))
      .map((l) => path.resolve(l.slice('worktree '.length).trim()));
    const main = roots[0];
    if (!main || roots.length < 2) return null;
    const here = (await git(['rev-parse', '--show-toplevel'], folder)).trim();
    if (!here || path.resolve(here) === main) return null;
    return { parent: main, siblings: roots.slice(1).filter((r) => r !== path.resolve(here)) };
  } catch {
    return null;
  }
}

/**
 * Should this run be given its parent repository, and why not when not.
 * Pure so the rule is testable: the parent is opened unless another live run
 * is working in it, because two crews in one checkout is the situation the
 * dirty-checkout guard exists to prevent.
 */
export function worktreeGrant(
  shape: WorktreeShape | null,
  busyFolders: Iterable<string>,
): { grant: string | null; reason?: string } {
  if (!shape) return { grant: null };
  const { parent, siblings } = shape;
  for (const f of busyFolders) {
    if (path.resolve(f) === parent) {
      return { grant: null, reason: `its parent repository ${parent} is held by another running mission` };
    }
  }
  // A grant is a subtree, so a worktree that lives *inside* the repository
  // (the common `/repo/.worktrees/x` layout) would be opened along with the
  // parent — and one of those may be another mission's workspace. The promise
  // that siblings stay closed cannot be kept by granting the parent here, so
  // the grant is declined and the human keeps deciding, one command at a time.
  const nested = siblings.filter((s) => s === parent || s.startsWith(parent + path.sep));
  if (nested.length) {
    return {
      grant: null,
      reason: `opening ${parent} would also open ${nested.length} other worktree${nested.length === 1 ? '' : 's'} inside it `
        + `(${nested.slice(0, 2).map((s) => path.basename(s)).join(', ')}${nested.length > 2 ? ', …' : ''})`,
    };
  }
  return { grant: parent };
}

/**
 * A fingerprint of everything this checkout has changed, for pinning a
 * reviewer's PASS to the code it actually read.
 *
 * Deliberately not computed from the deck: the deck is a *view* — it stops at
 * 200 files and carries no binary content — so a change to the 201st file, or
 * a swapped image, would leave a deck-derived hash identical and a stale PASS
 * looking current. This asks git instead: the full diff against HEAD including
 * binary deltas, plus the blob hash of every untracked file. Null when the
 * folder is not a repository or git will not answer, which callers must treat
 * as "cannot verify", never as "nothing changed".
 */
/** git's empty tree, for diffing a repository that has no commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FINGERPRINT_FILE_CAP = 20_000;
const FINGERPRINT_HASH_MAX_BYTES = 1024 * 1024;
const FINGERPRINT_SKIP = new Set(['.git', '.foreman', 'node_modules']);

/**
 * The same fingerprint for a folder that is not a repository — Foreman links
 * plain folders too, and a gate that only worked in git would make every
 * mission in one impossible to finish.
 *
 * Content-hashed up to a megabyte a file, size and mtime beyond that, since
 * reading a large binary on every gate check costs more than it proves.
 * Dependency trees and Foreman's own directory are skipped: they are not the
 * work under review. Null past the file cap, which the caller reads as
 * "cannot verify" — the honest answer for a tree too large to pin.
 */
async function walkFingerprint(folder: string): Promise<string | null> {
  const parts: string[] = [];
  const walk = async (dir: string, rel: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    // A directory we cannot read may be where the change is. Failing open
    // would let a PASS stand over work nobody could see.
    if (!entries) return false;
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (FINGERPRINT_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const here = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!await walk(full, here)) return false;
        continue;
      }
      if (!e.isFile()) continue;
      if (parts.length >= FINGERPRINT_FILE_CAP) return false;
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      if (st.size <= FINGERPRINT_HASH_MAX_BYTES) {
        const buf = await readFile(full).catch(() => null);
        parts.push(`${here}\0${st.size}\0${buf ? createHash('sha256').update(buf).digest('hex') : 'unreadable'}`);
      } else {
        parts.push(`${here}\0${st.size}\0${st.mtimeMs}`);
      }
    }
    return true;
  };
  if (!await walk(folder, '')) return null;
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export async function changeFingerprint(folder: string): Promise<string | null> {
  try {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], folder).catch(() => '');
    if (inside.trim() !== 'true') return walkFingerprint(folder);
    // HEAD is part of the fingerprint, not just the dirty tree: a director
    // that commits its work after a PASS leaves `git diff HEAD` empty, and a
    // fingerprint of the diff alone would call the new commit unchanged and
    // let the old PASS stand.
    // A repository with no commit yet has no HEAD to diff against, and a
    // mission that starts one is ordinary — so the comparison falls back to
    // git's empty tree rather than failing, which would make every run with a
    // required reviewer impossible to finish until someone committed.
    const head = (await git(['rev-parse', 'HEAD'], folder).catch(() => '')).trim();
    const tracked = await git(
      ['diff', head || EMPTY_TREE, '--binary', '--no-color', '--no-ext-diff'], folder, 60_000,
    );
    // -z, because `ls-files` C-quotes any path with a quote, a tab or a
    // non-ASCII character, and a quoted path handed back to `hash-object`
    // fails — which used to leave those files with no content in the hash at
    // all, so edits to them were invisible to the gate.
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], folder))
      .split('\0')
      // The mission doc and the crew's scratch space are Foreman's own and
      // change constantly; they are not the work under review.
      .filter((p) => p && !p.startsWith('.foreman/'));
    const parts: string[] = [`HEAD\0${head || 'none'}`, tracked];
    for (const p of untracked.sort()) {
      // No catch: a file whose hash cannot be read is a fingerprint that
      // cannot be trusted, and the honest answer is "cannot verify".
      const blob = await git(['hash-object', '--', p], folder);
      parts.push(`${p}\0${blob.trim()}`);
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  } catch {
    return null;
  }
}

export async function dirtyPaths(folder: string, limit = 8): Promise<string[]> {
  try {
    const out = await git(['status', '--porcelain', '--untracked-files=normal'], folder);
    return out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, limit);
  } catch {
    return [];
  }
}

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
 * The branch takes the run's title once there is one. Branches are created
 * before the title exists (the title is a model call that lands seconds
 * later), so they started from the brief's first words — and briefs that all
 * open with the same boilerplate gave every run the same name. Renamed in
 * place, only while nothing has been committed on it and it is still checked
 * out. Returns the new name, or null when it was left as it was.
 */
export async function renameMissionBranch(folder: string, from: string, title: string, runId: string): Promise<string | null> {
  const to = missionBranchName(title, runId);
  if (to === from) return null;
  const info = await gitInfo(folder);
  if (!info.repo || info.branch !== from) return null;
  try {
    await git(['branch', '-m', from, to], folder);
    return to;
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// The pull request: the one outward-facing act, and only ever on a button
// ---------------------------------------------------------------------------

/** `git@github.com:o/r.git` or `https://host/o/r(.git)` → the repository's web page. Null for anything else. */
export function remoteWebUrl(remote: string | undefined): { host: string; web: string; path: string } | null {
  if (!remote) return null;
  let m = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (m) return { host: m[1].toLowerCase(), path: m[2], web: `https://${m[1]}/${m[2]}` };
  m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (m) return { host: m[1].toLowerCase(), path: m[2], web: `https://${m[1]}/${m[2]}` };
  m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (m) return { host: m[1].toLowerCase(), path: m[2], web: `https://${m[1]}/${m[2]}` };
  return null;
}

/** Where a human finishes the pull request in a browser when `gh` is not around: GitHub, GitLab and Bitbucket forms; null elsewhere. */
export function compareUrl(remote: string | undefined, base: string, branch: string): string | null {
  const r = remoteWebUrl(remote);
  if (!r) return null;
  const enc = encodeURIComponent;
  if (r.host === 'github.com' || r.host.endsWith('.github.com')) return `${r.web}/compare/${enc(base)}...${enc(branch)}?expand=1`;
  if (r.host.includes('gitlab')) return `${r.web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(branch)}&merge_request%5Btarget_branch%5D=${enc(base)}`;
  if (r.host.includes('bitbucket')) return `${r.web}/pull-requests/new?source=${enc(branch)}&dest=${enc(base)}`;
  return `${r.web}`;
}

/** How much of a reviewer's findings go in the body; the rest is in the run's record. */
const FINDINGS_HEAD = 800;

/**
 * The pull request as Foreman drafts it: the run's title, and a body a reviewer
 * can read without opening Foreman.
 *
 * `reviews` is passed in rather than read from the run's record here, because
 * this module knows about git and nothing else — and because the caller is the
 * only one that knows which verdicts are the ones this branch was judged by.
 */
export function prDraft(
  run: { title?: string; mission: string; costUsd: number; costBasis?: string; git?: MissionGit },
  missionDoc: string | null,
  reviews?: readonly ReviewVerdict[],
): { title: string; body: string } {
  const first = run.mission.split('\n').find((l) => l.trim())?.trim() ?? 'Mission';
  const title = (run.title || first).slice(0, 120);
  const boxes = (missionDoc ?? '').split('\n').filter((l) => /^\s*[-*] \[[ xX]\]/.test(l)).map((l) => l.trim());
  const spend = run.costBasis === 'priced' || run.costBasis === undefined ? `$${run.costUsd.toFixed(2)}` : run.costBasis;
  const parts = [
    '## Mission', '', run.mission.trim(), '',
  ];
  if (boxes.length) parts.push('## Done when', '', ...boxes, '');
  // Who reviewed this before it was offered to a human, and what they said.
  // The whole point of the reviewer gate is that the answer travels with the
  // work; a PASS nobody outside Foreman can see is worth nothing on a branch.
  if (reviews?.length) {
    parts.push('## Review', '');
    for (const v of reviews) {
      parts.push(`**${v.name}: ${v.pass ? 'PASS' : 'FAIL'}**`);
      const head = v.findings.trim();
      if (head) {
        parts.push('', head.length > FINDINGS_HEAD ? `${head.slice(0, FINDINGS_HEAD).trimEnd()}\n\n… the rest is in the run's record.` : head);
      }
      parts.push('');
    }
  }
  parts.push('---', `Run by [Foreman](https://github.com/amenophis1er/foreman) on branch \`${run.git?.branch ?? ''}\` from \`${run.git?.base ?? ''}\` · spend ${spend}.`);
  return { title, body: parts.join('\n') };
}

/** `git push -u origin <branch>`, as the user. Null on success, git's reason otherwise. */
export async function pushBranch(folder: string, branch: string): Promise<string | null> {
  try {
    await git(['push', '-u', 'origin', branch], folder, 5 * 60_000);
    return null;
  } catch (err) {
    const t = err instanceof Error ? err.message : String(err);
    if (/could not read Username|Authentication failed|Permission denied|terminal prompts disabled/i.test(t)) {
      return 'Git could not authenticate to the remote. Set up a credential helper or gh auth, or use an SSH remote with a key this machine has.';
    }
    return t.replace(/^git push:\s*/, 'git push failed: ');
  }
}

/** Is GitHub's CLI here and signed in? Best effort, a few seconds at most. */
export async function ghReady(): Promise<{ present: boolean; authed: boolean }> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 8_000 }, (err) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ present: false, authed: false });
      resolve({ present: true, authed: !err });
    });
  });
}

/** What became of a pull request, from gh: open, merged or closed. Null when gh cannot say. */
export function pullRequestState(folder: string, url: string): Promise<{ state: 'open' | 'merged' | 'closed'; mergedAt?: string; number?: number } | null> {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', url, '--json', 'state,mergedAt,number'], {
      cwd: folder, timeout: 15_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const d = JSON.parse(String(stdout)) as { state?: string; mergedAt?: string | null; number?: number };
        const state = d.state === 'MERGED' ? 'merged' : d.state === 'CLOSED' ? 'closed' : d.state === 'OPEN' ? 'open' : null;
        resolve(state ? { state, mergedAt: d.mergedAt ?? undefined, number: d.number } : null);
      } catch { resolve(null); }
    });
  });
}

/**
 * The repository's default branch as origin sees it, from the remote HEAD git
 * recorded at clone time, then from the usual names, and `main` as the last
 * word. Local only: no network, so it works offline and cannot hang.
 */
export async function defaultBranch(folder: string): Promise<string> {
  try {
    const ref = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], folder)).trim();
    const name = ref.replace(/^origin\//, '');
    if (name) return name;
  } catch { /* no remote HEAD recorded */ }
  for (const name of ['main', 'master']) {
    try {
      await git(['rev-parse', '--verify', `refs/remotes/origin/${name}`], folder);
      return name;
    } catch { /* not this one */ }
  }
  return 'main';
}

/** Does origin have this branch? Asks the remote, and says no if it cannot ask. */
export async function remoteHasBranch(folder: string, branch: string): Promise<boolean> {
  try {
    const out = await git(['ls-remote', '--heads', 'origin', branch], folder, 10_000);
    return out.trim().length > 0;
  } catch {
    // Offline or unauthenticated: fall back to what the last fetch recorded.
    try {
      await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], folder);
      return true;
    } catch { return false; }
  }
}

/**
 * What a pull request from this mission should actually target.
 *
 * A finished mission leaves the checkout on its own branch, so the next
 * mission is branched from *that* — and records it as its base. That base
 * lives only on this machine, so `gh pr create --base foreman/…` fails and a
 * compare URL built from it 404s. When the recorded base is not on the
 * remote, the default branch is the honest target, and the caller says so
 * rather than quietly retargeting the request.
 */
export async function resolvePrBase(folder: string, recorded: string): Promise<{ base: string; fellBack: boolean }> {
  if (recorded && await remoteHasBranch(folder, recorded)) return { base: recorded, fellBack: false };
  const base = await defaultBranch(folder);
  return { base, fellBack: base !== recorded };
}

/** `gh pr create`, as the user. Resolves to the PR's URL, or to why not. */
export function createPullRequest(folder: string, opts: { base: string; branch: string; title: string; body: string }): Promise<{ url?: string; error?: string }> {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'create', '--base', opts.base, '--head', opts.branch, '--title', opts.title, '--body', opts.body], {
      cwd: folder, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ error: 'gh is not installed' });
        const t = String(stderr || err.message).trim();
        const existing = /already exists:\s*(https?:\S+)/.exec(t);
        if (existing) return resolve({ url: existing[1] });
        return resolve({ error: `gh pr create: ${t.split('\n').filter(Boolean).pop() ?? t}` });
      }
      const url = String(stdout).split('\n').map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
      resolve(url ? { url } : { error: 'gh did not return a pull request URL' });
    });
  });
}
