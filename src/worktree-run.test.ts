/**
 * A mission that runs in a worktree of its own must be an ordinary mission in
 * every other respect. The isolation design promises that everything
 * downstream — the deck, the reviewer gate's fingerprint, the closing commit,
 * the pull request's base, the dirty-checkout guard — keeps working unchanged
 * because it all follows `meta.folder`, which for such a run is the worktree.
 *
 * A promise of that shape is not provable by reading the code: each of those
 * callers asks git a question in a folder, and git answers differently in a
 * linked worktree than in the repository it came from. So each one is driven
 * here against a real repository with a real mission worktree, and each test
 * also checks the other half of the promise — that the repository's own
 * checkout is left exactly as it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  addMissionWorktree, changeFingerprint, closeMissionBranch, gitInfo, resolvePrBase,
} from './gitwork.js';
import { captureBaseline, deckFor } from './deck.js';
import { worktreePath, worktreeRemoval } from './isolation.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString();

/** Every throwaway directory a test made, torn down by its own `t.after`. */
type Scratch = { repo: string; home: string; wt: string; runId: string; branch: string; base: string; baseHead: string | null };

async function missionWorktree(t: { after: (fn: () => unknown) => void }, opts: { dirtyRepo?: boolean } = {}): Promise<Scratch> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'worktree-run-repo-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'worktree-run-home-'));
  t.after(async () => { await rm(repo, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 'me@example.com');
  sh(repo, 'config', 'user.name', 'Me');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'init');
  // Dirty *before* the worktree is made, when a test wants to prove the
  // worktree does not inherit the repository's uncommitted state.
  if (opts.dirtyRepo) await writeFile(path.join(repo, 'scratchpad.txt'), 'a human was mid-edit\n');

  const runId = '1788713434983-226123af';
  const wt = worktreePath(home, 'proj-1', runId);
  const made = await addMissionWorktree(repo, wt, 'Add a footer to the page', runId);
  if ('error' in made) throw new Error(`the worktree could not be created: ${made.error}`);
  return { repo, home, wt: made.path, runId, branch: made.branch, base: made.base, baseHead: made.baseHead };
}

test('the deck of a worktree run shows the worktree\'s changes and none of the repository\'s', async (t) => {
  const s = await missionWorktree(t);
  const baseline = await captureBaseline(s.wt, s.runId);
  assert.equal(baseline.kind, 'git', 'a worktree is a git work tree, so the baseline is a git one');

  await writeFile(path.join(s.wt, 'footer.html'), '<footer/>\n');
  // Written in the repository's own checkout, by a human or another mission:
  // it is not this run's work and must not appear in this run's deck.
  await writeFile(path.join(s.repo, 'unrelated.txt'), 'someone else\n');

  const deck = await deckFor(s.wt, s.runId);
  const paths = deck.files.map((f) => f.path);
  assert.deepEqual(paths, ['footer.html'], `the deck follows meta.folder into the worktree (note: ${deck.note ?? 'none'})`);
  assert.equal(deck.totals.files, 1, 'and counts exactly the one file the run changed');
  assert.ok(!paths.includes('unrelated.txt'), 'a file changed in the repository\'s own checkout is not the worktree run\'s change');
});

test('the reviewer gate\'s fingerprint follows the worktree and is scoped to it', async (t) => {
  const s = await missionWorktree(t);
  const first = await changeFingerprint(s.wt);
  assert.match(String(first), /^[0-9a-f]{64}$/, 'a worktree fingerprints like any other checkout');

  await writeFile(path.join(s.wt, 'footer.html'), '<footer/>\n');
  const afterWork = await changeFingerprint(s.wt);
  assert.notEqual(afterWork, first, 'work done in the worktree changes the fingerprint, so a stale PASS cannot stand');

  await writeFile(path.join(s.repo, 'unrelated.txt'), 'someone else\n');
  const afterOutside = await changeFingerprint(s.wt);
  assert.equal(afterOutside, afterWork, 'a change in the repository\'s own checkout does not invalidate the worktree\'s review');
});

test('the closing commit lands on the mission\'s branch from the worktree, leaving the repository\'s checkout alone', async (t) => {
  const s = await missionWorktree(t);
  const repoBranchBefore = sh(s.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const repoHeadBefore = sh(s.repo, 'rev-parse', 'HEAD').trim();

  await writeFile(path.join(s.wt, 'footer.html'), '<footer/>\n');
  const closed = await closeMissionBranch(s.wt, { branch: s.branch, base: s.base, baseHead: s.baseHead }, 'foreman: test');

  assert.equal(closed.error, undefined, 'closing a mission from a worktree is not an error');
  assert.equal(closed.committed, true, 'the uncommitted work was committed');
  assert.ok((closed.commits ?? 0) >= 1, `the branch is at least one commit ahead of its base (got ${closed.commits})`);
  assert.equal(sh(s.wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), s.branch, 'and the commit landed on the mission\'s own branch');
  assert.equal(sh(s.wt, 'status', '--porcelain').trim(), '', 'the worktree is clean afterwards');

  assert.equal(sh(s.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), repoBranchBefore, 'the repository is still on its original branch');
  assert.equal(sh(s.repo, 'rev-parse', 'HEAD').trim(), repoHeadBefore, 'at its original commit');
});

test('a pull request from a worktree run falls back to the default branch, and says so', async (t) => {
  const s = await missionWorktree(t);
  // No remote at all in a temp repository, which is the honest version of the
  // case this exists for: the recorded base is not a branch the remote has.
  assert.deepEqual(await resolvePrBase(s.wt, s.branch), { base: 'main', fellBack: true },
    'a base the remote does not have is replaced by the default branch, and the caller is told');
  assert.deepEqual(await resolvePrBase(s.wt, 'main'), { base: 'main', fellBack: false },
    'and a base that is already the default branch is not a fallback');
});

test('a fresh mission worktree is clean even when the repository\'s checkout is dirty', async (t) => {
  const s = await missionWorktree(t, { dirtyRepo: true });
  assert.equal((await gitInfo(s.repo)).dirty, true, 'the repository really is dirty');
  const info = await gitInfo(s.wt);
  assert.equal(info.repo, true, 'the worktree is a git work tree');
  assert.equal(info.branch, s.branch, 'on the mission\'s branch');
  assert.equal(info.dirty, false, 'and clean, so the dirty-checkout guard never fires for a worktree run');
});

test('a mission worktree lives under the worktrees root, where removal is allowed and the project\'s own folder is not', () => {
  const home = path.join(os.tmpdir(), 'worktree-run-paths');
  const root = path.join(home, 'worktrees');
  const wt = worktreePath(home, 'proj-1', 'run-1');

  assert.equal(path.dirname(path.dirname(wt)), root, 'a worktree is two levels under <home>/worktrees: project, then run');
  assert.ok(wt.startsWith(root + path.sep), 'and never anywhere else');

  assert.deepEqual(worktreeRemoval({ path: wt, foremanHome: home, live: false }), { ok: true },
    'a finished run\'s own worktree may be removed');
  const project = path.join(os.tmpdir(), 'worktree-run-project');
  const refused = worktreeRemoval({ path: project, foremanHome: home, live: false });
  assert.equal(refused.ok, false, 'the project\'s own folder is not a removable worktree');
  assert.equal(worktreeRemoval({ path: wt, foremanHome: home, live: true }).ok, false,
    'and a live run\'s worktree is not removable either');
});
