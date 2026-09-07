import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { closeMissionBranch, ensureMissionBranch, gitInfo, missionBranchName, startMissionBranch } from './gitwork.js';

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
});
