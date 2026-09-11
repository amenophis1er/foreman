/**
 * Whether a project runs its missions in its own checkout or in a worktree of
 * its own — and every decision that follows from that answer.
 *
 * Foreman has always run one mission per project, for a blunt reason: a mission
 * works in the project folder itself, and two agents editing one checkout —
 * each on its own branch, each running the tests — corrupt each other's work in
 * ways neither can see. A `worktree` project ends that by giving every run a
 * git worktree of its own under FOREMAN_HOME, so several missions can run at
 * once because none of them share a working tree.
 *
 * That one setting unlocks a family of new ways to lose work: a crafted run id
 * that writes outside the worktrees root, an `rm -rf` aimed at a path that
 * turned out to be the project's own checkout, a resumed run whose worktree was
 * deleted quietly reverting to the shared folder it was created to avoid. Each
 * of those is a rule, not a code path, so each one lives here as a pure
 * function a test can pin down — src/server.ts starts listening on import and
 * cannot be unit-tested, and a rule guarding somebody's repository is not
 * something to verify by reading a log afterwards.
 */
import path from 'node:path';

export type Isolation = 'shared' | 'worktree';

/**
 * The most missions Foreman will run at once in one project, whatever the
 * setting says. Not a technical limit — each mission is a full agent with its
 * own token budget, and a typo in a settings field should not be able to start
 * twenty of them.
 */
export const MAX_CONCURRENT_MISSIONS = 5;

/** What a worktree project gets when it has not chosen a number. */
export const DEFAULT_WORKTREE_CONCURRENCY = 2;

/**
 * Normalises an unknown settings value to an Isolation; anything unrecognised
 * is 'shared'.
 *
 * Settings are a loose record nobody validated on the way in, and 'shared' is
 * the reading that cannot surprise anyone: it is how every project behaved
 * before this existed, and it is the mode that does not create directories or
 * git worktrees on the strength of a misspelled string.
 */
export function isolationChoice(raw: unknown): Isolation {
  return raw === 'worktree' ? 'worktree' : 'shared';
}

/**
 * One path segment of an id, with anything that could mean "somewhere else"
 * taken out. Separators, drive colons and `..` all collapse to '_', so the
 * result is a single harmless name rather than a rejected request: the caller
 * of worktreePath is deriving a directory for a run that already exists, and
 * there is nothing useful it could do with a thrown error.
 */
function segment(raw: string): string {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '_');
  // A segment of dots is '.' or '..' by another name; an empty one would splice
  // itself out of the join and shorten the path by a level.
  return /^\.*$/.test(cleaned) ? '_' : cleaned;
}

/**
 * Where a run's worktree lives: `<foremanHome>/worktrees/<projectId>/<runId>`.
 *
 * Never inside the repository, and that is the whole design. A worktree nested
 * in the project folder is visible to the project's own tooling — git status,
 * the test runner's file watcher, a `find`, a build that globs — so the shared
 * checkout would see the isolated run's files and the isolation would be a
 * fiction. Under FOREMAN_HOME it is plainly Foreman's own storage, next to the
 * run records it belongs to, and removable without touching anyone's code.
 *
 * Both ids are sanitised because they reach this function from HTTP bodies and
 * settings files: a projectId of `../../..` would otherwise aim a whole
 * mission — and later a recursive delete — at a directory of the caller's
 * choosing.
 */
export function worktreePath(foremanHome: string, projectId: string, runId: string): string {
  return path.join(foremanHome, 'worktrees', segment(projectId), segment(runId));
}

/**
 * May this project be set to this isolation?
 *
 * `worktree` is a git feature, so it needs a git repository; refusing at the
 * moment the human chooses is the only place the refusal is cheap, because the
 * alternative is a project that looks configured and fails at every dispatch.
 *
 * And it needs the repository's ROOT, not a folder somewhere inside it. A
 * project linked at `<repo>/packages/api` is inside a work tree, so git says
 * yes — but `git worktree add` makes a checkout of the whole repository, and
 * the mission would be handed that root instead of the folder the human linked.
 * Working in a different directory than the project says is the kind of
 * surprise nobody notices until the diff is wrong.
 *
 * `root` undefined is unknown, not false: an older caller, or a folder git
 * would not answer for, must not be refused on a question that was never asked.
 */
export function isolationAllowed(
  isolation: Isolation,
  opts: { repo: boolean; root?: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (isolation !== 'worktree') return { ok: true };
  if (!opts.repo) {
    return { ok: false, reason: 'only a git repository can run missions in worktrees' };
  }
  if (opts.root === false) {
    return {
      ok: false,
      reason: 'only the root of a git repository can run missions in worktrees; this folder is inside one, '
        + 'and a worktree would give the mission the whole repository instead of this folder',
    };
  }
  return { ok: true };
}

/**
 * How many missions may run at once in this project.
 *
 * 'shared' is pinned at 1 whatever the setting says: the number is meaningless
 * without separate working trees, and a project that was switched from
 * worktree back to shared keeps its old `maxConcurrentMissions` sitting in
 * settings. Reading it there would let a stale field hand two agents the same
 * checkout, which is exactly the accident all of this exists to prevent.
 */
export function concurrencyLimit(isolation: Isolation, configured?: unknown): number {
  if (isolation !== 'worktree') return 1;
  // A number, or the string a settings form would store one as — but not a
  // boolean, which Number() would helpfully turn into a concurrency of 1.
  const n = typeof configured === 'number' ? configured
    : typeof configured === 'string' && configured.trim() !== '' ? Number(configured)
    : NaN;
  if (!Number.isFinite(n)) return DEFAULT_WORKTREE_CONCURRENCY;
  const whole = Math.floor(n);
  if (whole < 1) return DEFAULT_WORKTREE_CONCURRENCY;
  return Math.min(whole, MAX_CONCURRENT_MISSIONS);
}

/**
 * Whether one more mission may start here, and what to tell the caller when
 * not. The server puts the reason straight into a 409 body and Telegram prints
 * it, so it is one lower-case sentence with no trailing period — and for a
 * shared project it still reads the way the old hard-coded message did, because
 * that sentence is what everyone who uses Foreman already recognises.
 */
export function reservationDecision(input: {
  live: number; isolation: Isolation; configured?: unknown; projectName?: string;
}): { ok: true; limit: number } | { ok: false; limit: number; reason: string } {
  const limit = concurrencyLimit(input.isolation, input.configured);
  const live = Number.isFinite(input.live) ? Math.max(0, Math.floor(input.live)) : 0;
  if (live < limit) return { ok: true, limit };
  const who = input.projectName && input.projectName.trim() !== '' ? input.projectName.trim() : 'this project';
  if (limit === 1) return { ok: false, limit, reason: `${who} already has an active mission` };
  return {
    ok: false,
    limit,
    reason: `${who} already has ${live} missions running; the limit for this project is ${limit}`,
  };
}

/**
 * Which live run holds a repository through the parent-repository grant.
 *
 * A worktree run needs to reach the project's own `.git` — that is how a
 * worktree works — which means one run per repository is allowed to write
 * there: fetch, prune, branch bookkeeping. Two runs doing that at once fight
 * over the same index and lock files. The earliest-started run holds it, ties
 * broken by id so two runs recorded in the same millisecond always agree on
 * which of them won, on every server and after every restart.
 */
export function repoHolder(repo: string, live: readonly { id: string; repo: string | null; startedAt: number }[]): string | null {
  const target = path.resolve(repo);
  let held: { id: string; startedAt: number } | null = null;
  for (const run of live) {
    if (!run.repo || path.resolve(run.repo) !== target) continue;
    if (!held || run.startedAt < held.startedAt || (run.startedAt === held.startedAt && run.id < held.id)) {
      held = { id: run.id, startedAt: run.startedAt };
    }
  }
  return held ? held.id : null;
}

/**
 * May this worktree be removed?
 *
 * This is the guard in front of a recursive delete, so it fails closed on every
 * question it cannot answer: no recorded worktree means the path is a guess, a
 * live run means deleting the floor out from under a working agent, and a path
 * outside `<foremanHome>/worktrees` means the caller is about to delete
 * somebody's actual checkout. The prefix comparison ends in path.sep so that
 * `<home>/worktrees-evil/x` — a string that starts with the root and is not in
 * it — is refused, and the root itself is not removable because deleting it
 * takes every other project's worktrees with it.
 *
 * `warn` is not a refusal: work that exists only here is the human's to discard,
 * and all Foreman can usefully do is say so before asking again.
 */
export function worktreeRemoval(input: {
  path: string | null; foremanHome: string; live: boolean; commits?: number; unmerged?: boolean;
}): { ok: true; warn?: string } | { ok: false; reason: string } {
  if (!input.path) return { ok: false, reason: 'this run has no recorded worktree' };
  if (input.live) return { ok: false, reason: 'this run is still live; stop it before removing its worktree' };
  const root = path.resolve(input.foremanHome, 'worktrees');
  const target = path.resolve(input.path);
  if (target === root || !target.startsWith(root + path.sep)) {
    return { ok: false, reason: 'that path is not inside Foreman\'s worktrees directory' };
  }
  const commits = typeof input.commits === 'number' && input.commits > 0 ? input.commits : 0;
  if (input.unmerged && commits) {
    return {
      ok: true,
      warn: commits === 1
        ? 'this worktree\'s branch has 1 commit that is not merged anywhere else; removing it discards it'
        : `this worktree's branch has ${commits} commits that are not merged anywhere else; removing it discards them`,
    };
  }
  if (input.unmerged) {
    return { ok: true, warn: 'this worktree\'s branch is not merged anywhere else; removing it discards it' };
  }
  if (commits) {
    return { ok: true, warn: `this worktree's branch has ${commits} commit${commits === 1 ? '' : 's'}` };
  }
  return { ok: true };
}

/**
 * Resuming a run that was recorded as running in a worktree.
 *
 * If the worktree is gone — pruned, deleted by hand, a FOREMAN_HOME that moved
 * — the tempting repair is to carry on in the project folder. That is precisely
 * the collision worktrees exist to end: the resumed run would check out its
 * branch in the shared checkout, on top of whatever other missions are running
 * there. So it refuses, and says where the worktree was and that nothing will
 * fall back to the project folder, because the human is the only one who can
 * decide whether to recreate it or let the run go.
 *
 * No recorded worktree at all is fine: that is an ordinary shared run.
 */
export function resumeWorktree(input: {
  worktree: { path: string; repo: string; base: string } | null | undefined; exists: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const wt = input.worktree;
  if (!wt || !wt.path) return { ok: true };
  if (input.exists) return { ok: true };
  return {
    ok: false,
    reason:
      `this run's worktree at ${wt.path} no longer exists, and it will not be resumed in the ` +
      `project folder ${wt.repo} instead — that shared checkout is what the worktree was for. ` +
      'Recreate the worktree, or start a new mission',
  };
}
