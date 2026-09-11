import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  MAX_CONCURRENT_MISSIONS,
  DEFAULT_WORKTREE_CONCURRENCY,
  isolationChoice,
  worktreePath,
  isolationAllowed,
  concurrencyLimit,
  reservationDecision,
  repoClaim,
  worktreeRemoval,
  resumeWorktree,
  type Isolation, worktreeAutoRemove,
} from './isolation.js';

const HOME = path.resolve('/srv/foreman-home');

/**
 * A reservation as the common case asks it: a worktree run in a project whose
 * other runs are all in worktrees too. Each test names the part it is about.
 */
function reserve(over: Partial<{
  live: number; isolation: Isolation; configured: unknown; projectName: string;
  workspace: Isolation; sharedLive: number;
}> = {}) {
  return reservationDecision({
    live: 0, isolation: 'worktree', workspace: 'worktree', sharedLive: 0, ...over,
  });
}

test('isolationChoice: only the literal "worktree" opts in; everything else is shared', () => {
  assert.equal(isolationChoice('worktree'), 'worktree', 'the one recognised value means isolation');
  assert.equal(isolationChoice('shared'), 'shared');
  for (const raw of [undefined, null, '', 'Worktree', 'worktrees', 'isolated', 0, 1, true, {}, ['worktree']]) {
    assert.equal(isolationChoice(raw), 'shared', `${JSON.stringify(raw) ?? 'undefined'} is not consent to make worktrees`);
  }
});

test('worktreePath: a run gets <FOREMAN_HOME>/worktrees/<project>/<run>, outside the repository', () => {
  assert.equal(worktreePath(HOME, 'p1', 'run-7'), path.join(HOME, 'worktrees', 'p1', 'run-7'));
});

test('worktreePath: a crafted id cannot escape the worktrees root', () => {
  const root = path.join(HOME, 'worktrees');
  const crafted: Array<[string, string]> = [
    ['../../etc', 'run'],
    ['p1', '../../../../tmp/evil'],
    ['p1/../..', 'run'],
    ['..', '..'],
    ['.', '.'],
    ['', ''],
    ['p1\\..\\..', 'run'],
    ['C:p1', 'run'],
  ];
  for (const [projectId, runId] of crafted) {
    const out = worktreePath(HOME, projectId, runId);
    assert.ok(
      out.startsWith(root + path.sep),
      `worktreePath(${JSON.stringify(projectId)}, ${JSON.stringify(runId)}) stays under the worktrees root, got ${out}`,
    );
    // Two levels under the root and no deeper: the ids are one segment each.
    assert.equal(path.relative(root, out).split(path.sep).length, 2, 'a crafted id is still exactly one path segment');
    assert.ok(!out.includes('..'), 'no traversal survives into the path');
  }
});

test('isolationAllowed: worktrees need a git repository; shared needs nothing', () => {
  assert.deepEqual(isolationAllowed('worktree', { repo: true }), { ok: true });
  assert.deepEqual(isolationAllowed('shared', { repo: false }), { ok: true }, 'a plain folder can always run shared');
  const refused = isolationAllowed('worktree', { repo: false });
  assert.equal(refused.ok, false, 'a non-repository folder cannot be set to worktree');
  assert.ok(!refused.ok && /git repository/.test(refused.reason), `the reason says why: ${!refused.ok && refused.reason}`);
});

test('isolationAllowed: a subdirectory of a repository cannot run missions in worktrees', () => {
  assert.deepEqual(isolationAllowed('worktree', { repo: true, root: true }), { ok: true }, 'the repository\'s own root is fine');
  const inside = isolationAllowed('worktree', { repo: true, root: false });
  assert.equal(inside.ok, false, 'a worktree here would be a checkout of the whole repository');
  assert.ok(!inside.ok && /only the root of a git repository/.test(inside.reason), `the reason says why: ${!inside.ok && inside.reason}`);
  // A separate sentence from the non-repository one: the two refusals send the
  // human to different fixes.
  const notRepo = isolationAllowed('worktree', { repo: false, root: false });
  assert.ok(!notRepo.ok && !inside.ok && notRepo.reason !== inside.reason);
  // Unknown is not false: an older caller, or a folder git would not answer for.
  assert.deepEqual(isolationAllowed('worktree', { repo: true }), { ok: true });
  assert.deepEqual(isolationAllowed('worktree', { repo: true, root: undefined }), { ok: true });
  assert.deepEqual(isolationAllowed('shared', { repo: true, root: false }), { ok: true });
});

test('concurrencyLimit: a shared project stays at 1 even when maxConcurrentMissions says 5', () => {
  assert.equal(concurrencyLimit('shared', 5), 1, 'a stale setting cannot hand two agents one checkout');
  assert.equal(concurrencyLimit('shared', undefined), 1);
  assert.equal(concurrencyLimit('shared', 99), 1);
});

test('concurrencyLimit: a worktree project takes a whole number, clamped, else the default', () => {
  assert.equal(concurrencyLimit('worktree', 3), 3);
  assert.equal(concurrencyLimit('worktree', 1), 1);
  assert.equal(concurrencyLimit('worktree', '4'), 4, 'settings JSON may hold the number as a string');
  assert.equal(concurrencyLimit('worktree', 2.7), 2, 'a fraction rounds down rather than being rejected');
  assert.equal(
    concurrencyLimit('worktree', 50), MAX_CONCURRENT_MISSIONS,
    'nothing the settings say gets past the ceiling',
  );
  for (const raw of [undefined, null, 0, -3, NaN, Infinity, 'lots', {}, true]) {
    assert.equal(
      concurrencyLimit('worktree', raw), DEFAULT_WORKTREE_CONCURRENCY,
      `${String(raw)} is not a limit, so the default applies`,
    );
  }
});

test('reservationDecision: a shared project admits one mission and refuses the second in the old words', () => {
  assert.deepEqual(reserve({ isolation: 'shared', workspace: 'shared' }), { ok: true, limit: 1 });
  const refused = reserve({ live: 1, isolation: 'shared', workspace: 'shared', sharedLive: 1 });
  assert.deepEqual(refused, {
    ok: false, limit: 1, reason: 'this project already has an active mission',
  }, 'the sentence everyone already recognises is unchanged');
});

test('reservationDecision: a named shared project is named in the refusal', () => {
  const refused = reserve({ live: 1, isolation: 'shared', workspace: 'shared', sharedLive: 1, projectName: 'Foreman' });
  assert.ok(!refused.ok && refused.reason === 'Foreman already has an active mission', refused.ok ? 'expected a refusal' : refused.reason);
});

test('reservationDecision: a third mission in a worktree project is refused with the limit named', () => {
  assert.deepEqual(reserve({ live: 1, configured: 2 }), { ok: true, limit: 2 });
  const refused = reserve({ live: 2, configured: 2 });
  assert.deepEqual(refused, {
    ok: false,
    limit: 2,
    reason: 'this project already has 2 missions running; the limit for this project is 2',
  }, 'the caller is told the number it hit, not just that it hit one');
  const reason = !refused.ok ? refused.reason : '';
  assert.ok(!/\.$/.test(reason), 'no trailing period — the server drops it into a 409 body');
  assert.equal(reason[0], reason[0].toLowerCase(), 'lower case start, since it is quoted mid-sentence');
});

test('reservationDecision: an unconfigured worktree project gets the default, and a nonsense live count is 0', () => {
  assert.deepEqual(reserve({ live: 1 }), { ok: true, limit: DEFAULT_WORKTREE_CONCURRENCY });
  assert.deepEqual(
    reserve({ live: NaN, isolation: 'shared', workspace: 'shared' }), { ok: true, limit: 1 },
    'an uncountable live count is treated as none rather than blocking every dispatch',
  );
  assert.deepEqual(
    reserve({ live: 1, sharedLive: NaN }), { ok: true, limit: DEFAULT_WORKTREE_CONCURRENCY },
    'and neither does an uncountable count of runs in the project folder',
  );
});

test('reservationDecision: two runs in the project\'s own checkout are refused even under a worktree limit', () => {
  // The migration case: a run recorded before the project was flipped to
  // 'worktree' works in the project folder, and resuming a second one there
  // would put two agents in one checkout — the collision this feature ends.
  const refused = reserve({ live: 1, configured: 3, workspace: 'shared', sharedLive: 1 });
  assert.equal(refused.ok, false, 'the limit had room, and the project folder did not');
  assert.equal(refused.limit, 3, 'the limit is still reported as what it is');
  const reason = !refused.ok ? refused.reason : '';
  assert.ok(/project folder/.test(reason) && /one mission at a time/.test(reason), `its own sentence, not the limit's: ${reason}`);
  assert.ok(!/\.$/.test(reason), 'no trailing period — the server drops it into a 409 body');
  assert.equal(reason[0], reason[0].toLowerCase(), 'lower case start, since it is quoted mid-sentence');
  const named = reserve({ live: 1, configured: 3, workspace: 'shared', sharedLive: 1, projectName: 'Foreman' });
  assert.ok(!named.ok && named.reason.startsWith('Foreman '), 'and it names the project like the others');
});

test('reservationDecision: the project folder holds up only the run that would work in it', () => {
  assert.deepEqual(
    reserve({ live: 1, configured: 3, workspace: 'worktree', sharedLive: 1 }), { ok: true, limit: 3 },
    'a new run with a worktree of its own is not in the shared checkout at all',
  );
  assert.deepEqual(
    reserve({ live: 0, configured: 3, workspace: 'shared', sharedLive: 0 }), { ok: true, limit: 3 },
    'the FIRST run in the project folder is fine; it is the second that is not',
  );
  // A shared project's second mission still meets the limit first, so the
  // sentence everyone recognises is the one it gets.
  const both = reserve({ live: 1, isolation: 'shared', workspace: 'shared', sharedLive: 1 });
  assert.ok(!both.ok && both.reason === 'this project already has an active mission', 'the limit answers first');
});

test('repoClaim: a repository nobody holds is taken, and the holder keeps it', () => {
  assert.deepEqual(repoClaim({ repo: '/repos/alpha', holder: null, runId: 'r1' }), { hold: true });
  assert.deepEqual(repoClaim({ repo: '/repos/alpha', holder: undefined, runId: 'r1' }), { hold: true });
  assert.deepEqual(
    repoClaim({ repo: '/repos/alpha', holder: 'r1', runId: 'r1' }), { hold: true },
    'a resume re-asks, and a run must not be refused its own repository',
  );
});

test('repoClaim: a repository another run holds is refused, whoever asks and whenever', () => {
  const refused = repoClaim({ repo: '/repos/alpha', holder: 'r1', runId: 'r2' });
  assert.equal(refused.hold, false, 'first come; the incumbent is not displaced');
  assert.ok(
    !refused.hold && refused.reason === 'the repository /repos/alpha is held by another running mission',
    `the reason names the repository: ${!refused.hold && refused.reason}`,
  );
  // Age does not enter into it: an older run asking later is still refused,
  // which is precisely the resume that used to take the grant off a live run.
  assert.equal(repoClaim({ repo: '/repos/alpha', holder: 'newer', runId: 'older' }).hold, false);
});

test('worktreeRemoval: a finished run\'s worktree under FOREMAN_HOME is removable', () => {
  assert.deepEqual(worktreeRemoval({
    path: path.join(HOME, 'worktrees', 'p1', 'r1'), foremanHome: HOME, live: false,
  }), { ok: true });
});

test('worktreeRemoval: no recorded worktree, or a live run, refuses', () => {
  const none = worktreeRemoval({ path: null, foremanHome: HOME, live: false });
  assert.ok(!none.ok && /no recorded worktree/.test(none.reason), 'a path Foreman never recorded is a guess, not a target');
  const live = worktreeRemoval({ path: path.join(HOME, 'worktrees', 'p1', 'r1'), foremanHome: HOME, live: true });
  assert.ok(!live.ok && /still live/.test(live.reason), 'a working agent does not get the floor pulled out from under it');
});

test('worktreeRemoval: a path outside FOREMAN_HOME is never removable', () => {
  const outside = [
    '/repos/alpha',
    path.join(HOME, 'runs', 'r1'),
    path.join(HOME, 'worktrees', '..', '..', 'repos', 'alpha'),
    path.join(HOME, 'worktrees', 'p1', '..', '..', '..', 'alpha'),
    `${HOME}-evil/worktrees/p1/r1`,
    `${path.join(HOME, 'worktrees')}-evil/x`,
    path.join(HOME, 'worktrees'),
  ];
  for (const p of outside) {
    const out = worktreeRemoval({ path: p, foremanHome: HOME, live: false });
    assert.equal(out.ok, false, `${p} is not inside Foreman's worktrees and must not be deleted`);
    assert.ok(!out.ok && /worktrees directory/.test(out.reason), `the reason says where it had to be, got: ${!out.ok && out.reason}`);
  }
});

test('worktreeRemoval: unmerged work is a warning, not a refusal', () => {
  const at = path.join(HOME, 'worktrees', 'p1', 'r1');
  const unmerged = worktreeRemoval({ path: at, foremanHome: HOME, live: false, unmerged: true, commits: 3 });
  assert.equal(unmerged.ok, true, 'discarding their own work is the human\'s call');
  assert.ok(unmerged.ok && /3 commits that are not merged anywhere else/.test(unmerged.warn ?? ''), `the warning counts what is at stake: ${unmerged.ok && unmerged.warn}`);
  const one = worktreeRemoval({ path: at, foremanHome: HOME, live: false, unmerged: true, commits: 1 });
  // The verb agrees with the count: "1 commit that IS not merged".
  assert.ok(one.ok && /1 commit that is not merged anywhere else/.test(one.warn ?? ''), `one commit, singular: ${one.ok && one.warn}`);
  const noCount = worktreeRemoval({ path: at, foremanHome: HOME, live: false, unmerged: true });
  assert.ok(noCount.ok && /not merged/.test(noCount.warn ?? ''), 'unmerged still warns without a count');
  const merged = worktreeRemoval({ path: at, foremanHome: HOME, live: false, commits: 2 });
  assert.ok(merged.ok && /2 commits/.test(merged.warn ?? ''), 'commits alone are still worth mentioning');
  const clean = worktreeRemoval({ path: at, foremanHome: HOME, live: false, commits: 0, unmerged: false });
  assert.deepEqual(clean, { ok: true }, 'nothing to lose, nothing to warn about');
});

test('resumeWorktree: a resumed run whose worktree is gone refuses rather than falling back', () => {
  const worktree = { path: path.join(HOME, 'worktrees', 'p1', 'r1'), repo: '/repos/alpha', base: 'main' };
  const refused = resumeWorktree({ worktree, exists: false });
  assert.equal(refused.ok, false, 'the shared checkout is exactly what the worktree was avoiding');
  const reason = !refused.ok ? refused.reason : '';
  assert.ok(reason.includes(worktree.path), `the reason says where the worktree was: ${reason}`);
  assert.ok(reason.includes('/repos/alpha'), 'and which folder it will not silently use instead');
  assert.ok(/will not be resumed in the project folder/.test(reason), 'and that there is no silent fallback');
});

test('resumeWorktree: a worktree that is still there, and an ordinary shared run, both resume', () => {
  const worktree = { path: path.join(HOME, 'worktrees', 'p1', 'r1'), repo: '/repos/alpha', base: 'main' };
  assert.deepEqual(resumeWorktree({ worktree, exists: true }), { ok: true });
  assert.deepEqual(resumeWorktree({ worktree: null, exists: false }), { ok: true }, 'a shared run never had one to lose');
  assert.deepEqual(resumeWorktree({ worktree: undefined, exists: false }), { ok: true });
});

test('an unknown outcome is not an empty mission: the worktree stays', () => {
  const clean = { status: 'done', closeError: null, commits: 0, dirty: false };
  assert.equal(worktreeAutoRemove(clean), true, 'finished, committed nothing, nothing left');

  // The case that cost work: the closing commit failed, so nobody counted the
  // commits — and `--force` removal would have taken the crew's files with it.
  assert.equal(worktreeAutoRemove({ ...clean, closeError: 'pre-commit hook rejected', commits: undefined }), false);
  assert.equal(worktreeAutoRemove({ ...clean, commits: undefined }), false, 'no count is not a zero count');
  assert.equal(worktreeAutoRemove({ ...clean, dirty: true }), false, 'work left in the tree keeps it');
  assert.equal(worktreeAutoRemove({ ...clean, dirty: undefined }), false, 'and so does not being able to look');
  assert.equal(worktreeAutoRemove({ ...clean, commits: 2 }), false, 'a mission that produced commits keeps its checkout');
  assert.equal(worktreeAutoRemove({ ...clean, status: 'interrupted' }), false, 'an interrupted run needs it to resume');
  assert.equal(worktreeAutoRemove({ ...clean, status: 'error' }), false);
});
