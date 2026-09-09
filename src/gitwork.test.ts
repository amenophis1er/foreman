import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { closeMissionBranch, defaultBranch, worktreeGrant, worktreeParent, ensureMissionBranch, gitInfo, missionBranchName, remoteHasBranch, resolvePrBase, startMissionBranch, renameMissionBranch, dirtyPaths,
} from './gitwork.js';
import type { ReviewVerdict } from './crew.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString();

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gitwork-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'me@example.com');
  sh(dir, 'config', 'user.name', 'Me');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('missionBranchName: readable, bounded, unique per run', () => {
  assert.equal(missionBranchName('Build Tick, a vanilla Pomodoro timer\nmore', '1788713434983-226123af'), 'foreman/build-tick-a-vanilla-pomodoro-timer-23af');
  assert.match(missionBranchName('   \n!!!', 'run-xyz9'), /^foreman\/mission-xyz9$/);
  assert.ok(missionBranchName('a '.repeat(80), 'r1').length < 60);
});

test('gitInfo: a plain folder is not a repo; a repo reports branch, head, dirty, remote', async () => {
  const plain = await mkdtemp(path.join(os.tmpdir(), 'gitwork-plain-'));
  assert.deepEqual(await gitInfo(plain), { repo: false });
  const dir = await repo();
  const info = await gitInfo(dir);
  assert.equal(info.repo, true); assert.equal(info.branch, 'main'); assert.equal(info.dirty, false); assert.ok(info.head);
  sh(dir, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');
  await writeFile(path.join(dir, 'x.txt'), 'x');
  const again = await gitInfo(dir);
  assert.equal(again.dirty, true); assert.equal(again.remote, 'git@github.com:acme/widget.git');
});

test('a mission gets its own branch from the current one, and closing commits the work on it', async () => {
  const dir = await repo();
  const g = await startMissionBranch(dir, 'Add a footer to the page', 'run-1234abcd');
  assert.ok(!('error' in g), JSON.stringify(g));
  if ('error' in g) return;
  assert.equal(g.branch, 'foreman/add-a-footer-to-the-page-abcd');
  assert.equal(g.base, 'main');
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), g.branch);

  // Nothing to commit yet: no commit, zero commits ahead.
  const idle = await closeMissionBranch(dir, g, 'foreman: nothing');
  assert.equal(idle.committed, false); assert.equal(idle.commits, 0); assert.equal(idle.error, undefined);

  await writeFile(path.join(dir, 'footer.html'), '<footer/>');
  const closed = await closeMissionBranch(dir, g, 'foreman: Add a footer');
  assert.equal(closed.committed, true); assert.equal(closed.commits, 1); assert.ok(closed.commit);
  assert.equal(sh(dir, 'status', '--porcelain').trim(), '');
  assert.match(sh(dir, 'log', '-1', '--format=%s'), /^foreman: Add a footer/);
  // main is untouched.
  assert.equal(sh(dir, 'rev-list', '--count', 'main').trim(), '1');
});

test('ensureMissionBranch goes back to the branch for a resume, and says why when it cannot', async () => {
  const dir = await repo();
  const g = await startMissionBranch(dir, 'Thing', 'run-1');
  if ('error' in g) throw new Error(g.error);
  sh(dir, 'checkout', '-q', 'main');
  assert.equal(await ensureMissionBranch(dir, g.branch), null);
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), g.branch);
  assert.match((await ensureMissionBranch(dir, 'foreman/does-not-exist')) ?? '', /checkout/);
});

test('startMissionBranch on a plain folder says so instead of throwing', async () => {
  const plain = await mkdtemp(path.join(os.tmpdir(), 'gitwork-plain2-'));
  assert.deepEqual(await startMissionBranch(plain, 'x', 'r'), { error: 'not a git repository' });
});

test('remoteWebUrl and compareUrl: the three hosts people use, and a plain page elsewhere', async () => {
  const { remoteWebUrl, compareUrl } = await import('./gitwork.js');
  assert.deepEqual(remoteWebUrl('git@github.com:acme/widget.git'), { host: 'github.com', path: 'acme/widget', web: 'https://github.com/acme/widget' });
  assert.deepEqual(remoteWebUrl('https://gitlab.com/group/sub/widget.git'), { host: 'gitlab.com', path: 'group/sub/widget', web: 'https://gitlab.com/group/sub/widget' });
  assert.equal(remoteWebUrl(undefined), null);
  assert.equal(compareUrl('git@github.com:acme/widget.git', 'main', 'foreman/x-1'), 'https://github.com/acme/widget/compare/main...foreman%2Fx-1?expand=1');
  assert.match(compareUrl('https://gitlab.com/g/w.git', 'main', 'foreman/x') ?? '', /merge_requests\/new\?merge_request%5Bsource_branch%5D=foreman%2Fx/);
  assert.match(compareUrl('git@bitbucket.org:t/w.git', 'main', 'foreman/x') ?? '', /pull-requests\/new\?source=foreman%2Fx&dest=main/);
  assert.equal(compareUrl('https://git.example.com/a/b', 'main', 'x'), 'https://git.example.com/a/b');
});

test('prDraft: the run title, the brief, the boxes as the mission left them, and a footer', async () => {
  const { prDraft } = await import('./gitwork.js');
  const d = prDraft({ title: 'Add a footer', mission: 'Add a footer to the page.\nKeep it small.', costUsd: 0.42, costBasis: 'priced', git: { branch: 'foreman/add-a-footer-ab12', base: 'main', baseHead: null } },
    '# Mission\n- [x] footer.html exists\n- [ ] linked from index\n');
  assert.equal(d.title, 'Add a footer');
  assert.match(d.body, /## Mission\n\nAdd a footer to the page\.\nKeep it small\./);
  assert.match(d.body, /## Done when\n\n- \[x\] footer\.html exists\n- \[ \] linked from index/);
  assert.match(d.body, /branch `foreman\/add-a-footer-ab12` from `main` · spend \$0\.42/);
  assert.ok(!/## Review/.test(d.body), 'a run nobody reviewed says nothing about review');
});

test('prDraft: the reviewers and their verdicts, with the head of the findings', async () => {
  const { prDraft } = await import('./gitwork.js');
  const verdict = (over: Partial<ReviewVerdict>): ReviewVerdict => ({
    presetId: 'reviewer', name: 'Reviewer', pass: true, findings: '', diffHash: 'h', workerId: 'w1', at: 1, ...over,
  });
  const d = prDraft(
    { mission: 'Add a footer.', costUsd: 1, costBasis: 'priced', git: { branch: 'b', base: 'main', baseHead: null } },
    null,
    [
      verdict({ findings: '- footer.html:12 the year is hard-coded' }),
      verdict({ presetId: 'security-review', name: 'Security review', pass: false, findings: `x${'y'.repeat(2000)}` }),
    ],
  );
  assert.match(d.body, /## Review\n\n\*\*Reviewer: PASS\*\*\n\n- footer\.html:12 the year is hard-coded/);
  assert.match(d.body, /\*\*Security review: FAIL\*\*/);
  assert.match(d.body, /… the rest is in the run's record\./, 'a long findings list is cut, not pasted whole');
  assert.ok(d.body.length < 2000, 'the body stays a pull request, not an archive');
});


test('renameMissionBranch takes the run title once there is one, and leaves a branch that moved on', async () => {
  const dir = await repo();
  const g = await startMissionBranch(dir, 'Repo: this folder is a git worktree. Do the thing.', '1788713434983-226123af');
  assert.ok(!('error' in g));
  assert.equal(g.branch, 'foreman/repo-this-folder-is-a-git-23af');
  const renamed = await renameMissionBranch(dir, g.branch, 'Studio data sanitization and null handling', '1788713434983-226123af');
  assert.equal(renamed, 'foreman/studio-data-sanitization-and-null-23af');
  assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), renamed);
  // Same name again: nothing to do. Not on the branch any more: left alone.
  assert.equal(await renameMissionBranch(dir, renamed!, 'Studio data sanitization and null handling', '1788713434983-226123af'), null);
  sh(dir, 'checkout', '-q', 'main');
  assert.equal(await renameMissionBranch(dir, renamed!, 'Another title', '1788713434983-226123af'), null);
});

test('dirtyPaths names the uncommitted work a mission branch would carry', async () => {
  const dir = await repo();
  assert.deepEqual(await dirtyPaths(dir), [], 'a clean checkout carries nothing');

  await writeFile(path.join(dir, 'README.md'), 'hello, edited\n');
  await writeFile(path.join(dir, 'scratch.txt'), 'untracked\n');
  const dirty = await dirtyPaths(dir);
  assert.deepEqual(dirty.sort(), ['README.md', 'scratch.txt'], 'tracked edits and untracked files both count');

  // The cap is for a message, not for the truth of it.
  assert.equal((await dirtyPaths(dir, 1)).length, 1);
  // Not a repository at all: nothing to report, and no throw.
  assert.deepEqual(await dirtyPaths(os.tmpdir()), []);
});

test('a pull request targets the default branch when the mission was branched from a local-only branch', async () => {
  const dir = await repo();
  // A bare origin, the way a real clone has one.
  const origin = await mkdtemp(path.join(os.tmpdir(), 'gitwork-origin-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-q', '-u', 'origin', 'main');

  assert.equal(await defaultBranch(dir), 'main');
  assert.equal(await remoteHasBranch(dir, 'main'), true);
  assert.equal(await remoteHasBranch(dir, 'foreman/earlier-1234'), false);

  // Branched from main: the base is real and is left alone.
  assert.deepEqual(await resolvePrBase(dir, 'main'), { base: 'main', fellBack: false });

  // The case from the field: the checkout was left on the previous mission's
  // branch, so this mission recorded that as its base and it exists nowhere
  // but here. gh would fail on it; the default branch is the honest target.
  sh(dir, 'checkout', '-q', '-b', 'foreman/earlier-1234');
  assert.deepEqual(await resolvePrBase(dir, 'foreman/earlier-1234'), { base: 'main', fellBack: true });
});

test('worktreeParent: a linked worktree knows its repository, and nothing else claims one', async () => {
  const dir = await repo();
  assert.equal(await worktreeParent(dir), null, 'the main worktree has no parent');
  assert.equal(await worktreeParent(os.tmpdir()), null, 'a plain directory is not a worktree');

  const wt = path.join(await mkdtemp(path.join(os.tmpdir(), 'gitwork-wt-')), 'feature');
  sh(dir, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const shape = await worktreeParent(wt);
  assert.equal(shape && await realpath(shape.parent), await realpath(dir), 'the linked worktree points back at the repository');
  assert.deepEqual(shape?.siblings, [], 'and it is the only linked worktree');
  assert.equal(await worktreeParent(dir), null, 'and the main worktree still has none');
});

test('worktreeGrant opens the parent unless a live run is working in it', () => {
  const shape = (siblings: string[] = []) => ({ parent: '/repos/app', siblings });
  assert.deepEqual(worktreeGrant(shape(), []), { grant: '/repos/app' });
  assert.deepEqual(worktreeGrant(shape(['/elsewhere/wt-a']), ['/repos/other']), { grant: '/repos/app' },
    'a sibling outside the parent is not opened by opening the parent');
  // Two crews in one checkout is the thing the dirty-checkout guard exists to
  // prevent; opening the parent into a live mission would arrange it.
  assert.deepEqual(worktreeGrant(shape(), ['/repos/app']), {
    grant: null, reason: 'its parent repository /repos/app is held by another running mission',
  });
  // A grant is a subtree: worktrees kept inside the repository would ride
  // along with it, so the parent is not opened at all.
  const nested = worktreeGrant(shape(['/repos/app/.worktrees/a', '/repos/app/.worktrees/b']), []);
  assert.equal(nested.grant, null);
  assert.match(nested.reason ?? '', /would also open 2 other worktrees inside it/);
  assert.deepEqual(worktreeGrant(null, []), { grant: null }, 'not a worktree: nothing to say');
});

test('a worktree kept inside the repository is not opened by opening the repository', async () => {
  const dir = await repo();
  // The common layout codex flagged: linked worktrees under the main checkout.
  const inside = path.join(dir, '.worktrees', 'a');
  sh(dir, 'worktree', 'add', '-q', '-b', 'inside-a', inside);
  const other = path.join(dir, '.worktrees', 'b');
  sh(dir, 'worktree', 'add', '-q', '-b', 'inside-b', other);

  const shape = await worktreeParent(inside);
  assert.ok(shape, 'it is a linked worktree');
  assert.equal(await realpath(shape.parent), await realpath(dir));
  assert.ok(shape.siblings.some((s) => s.endsWith(path.join('.worktrees', 'b'))), 'and it can see its sibling');

  const decision = worktreeGrant(shape, []);
  assert.equal(decision.grant, null, 'so the parent is not opened automatically');
  assert.match(decision.reason ?? '', /would also open/);
});
