/**
 * Permission policy tests — the Bash folder-boundary heuristic and its wiring
 * into `makePolicy`. Nothing here touches the filesystem: paths are strings
 * fed to a pure function, and the policy hooks are recorded in memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  bashEscape, bashEscapesFolder, makePolicy, ESCAPE_GRANT_HINT, WORK_DIR, isTempPath, tempDirDenial, tempRoots,
  type PendingPermission, type PolicyHooks,
} from './policy.js';

const FOLDER = '/Users/x/proj';
const ROOT = '/tmp/foreman-verify'; // the path from the live bug report
const escapes = (cmd: string) => bashEscapesFolder(cmd, FOLDER);

// ---------------------------------------------------------------------------
// bashEscapesFolder — commands that must prompt
// ---------------------------------------------------------------------------

test('the real-world playwright install in /tmp escapes', () => {
  const reason = escapes('mkdir -p /tmp/foreman-verify && cd /tmp/foreman-verify && npm init -y && npm install playwright');
  assert.equal(reason, 'mkdir -p /tmp/foreman-verify — creates a path outside the mission folder');
});

test('cd to an outside dir escapes on its own, even before any write', () => {
  assert.equal(escapes('cd /tmp && npm install'), 'cd /tmp — writes after this land outside the mission folder');
  assert.ok(escapes('cd ~ && ls'));
  assert.ok(escapes('cd && ls'), 'bare cd goes home');
  assert.ok(escapes('cd .. && ls'), 'parent of the folder is outside');
  assert.ok(escapes('cd $HOME/.foreman'));
});

test('a segment after `cd /tmp;` escapes (taint) with a relative write', () => {
  const reason = escapes('cd /tmp; touch a');
  assert.ok(reason);
  assert.match(reason, /outside the mission folder/);
});

test('redirections to an outside path escape', () => {
  assert.match(escapes('echo hi > /tmp/out.txt')!, /redirects output outside/);
  assert.ok(escapes('> /tmp/out.txt'));
  assert.ok(escapes('npm test >> ~/log.txt'));
  assert.ok(escapes('npm test 2> /tmp/err.log'));
  assert.ok(escapes('npm test &> $HOME/all.log'));
  assert.ok(escapes('cat x | tee /tmp/copy.txt'));
});

test('write verbs on outside paths escape, including system locations', () => {
  assert.equal(escapes('rm -rf /opt/homebrew'), 'rm -rf /opt/homebrew — deletes a path outside the mission folder');
  assert.ok(escapes('touch ~/.zshrc'));
  assert.ok(escapes('cp ./dist/a /usr/local/bin/a'));
  assert.ok(escapes('mv build /tmp/build'));
  assert.ok(escapes('ln -s ./bin/x ~/bin/x'));
  assert.ok(escapes('chmod +x /usr/local/bin/foo'));
  assert.ok(escapes('sed -i "s/a/b/" /etc/hosts'));
  assert.ok(escapes('sudo mkdir /var/lib/foo'), 'wrappers are peeled');
  assert.ok(escapes('FOO=1 /bin/rm -rf /tmp/x'), 'assignments peeled, verb by basename');
  assert.ok(escapes('mkdir ../sibling'), 'dot-relative paths resolve against the folder');
});

test('find escapes only when it deletes or execs a write verb', () => {
  assert.equal(escapes('find / -name x'), null);
  assert.equal(escapes('find /tmp -name "*.log"'), null);
  assert.ok(escapes('find /tmp -delete'));
  assert.ok(escapes('find /tmp -name "*.log" -exec rm {} \;'));
  assert.equal(escapes('find /tmp -exec cat {} \;'), null);
});

test('directory options of installers, archivers and downloaders count', () => {
  assert.ok(escapes('npm install --prefix /tmp/x playwright'));
  assert.ok(escapes('npm install --prefix=/tmp/x playwright'));
  assert.ok(escapes('pip install -t /tmp/site requests'));
  assert.ok(escapes('unzip a.zip -d /tmp/out'));
  assert.ok(escapes('tar -xzf a.tgz -C /tmp/out'));
  assert.ok(escapes('curl -o /tmp/f https://example.com/f'));
  assert.ok(escapes('git clone https://github.com/a/b /tmp/b'));
  assert.ok(escapes('git init /tmp/fresh'));
  assert.ok(escapes('dd if=/dev/zero of=/tmp/img bs=1m count=1'));
});

// ---------------------------------------------------------------------------
// bashEscapesFolder — commands that must stay silent
// ---------------------------------------------------------------------------

test('reads of outside paths do not escape', () => {
  assert.equal(escapes('cat /etc/hosts'), null);
  assert.equal(escapes('ls ~/.foreman'), null);
  assert.equal(escapes('ls $HOME/.foreman'), null);
  assert.equal(escapes('which node'), null);
  assert.equal(escapes('head -n 5 /var/log/system.log | grep foo'), null);
  assert.equal(escapes('diff /etc/hosts ./hosts'), null);
  assert.equal(escapes('stat /usr/bin/env && wc -l /etc/passwd'), null);
  assert.equal(escapes('cp /etc/hosts ./hosts'), null, 'copying an outside SOURCE in is fine');
  assert.equal(escapes('pip install -r /etc/reqs.txt'), null, 'reading a requirements file is fine');
});

test('writes inside the folder do not escape', () => {
  assert.equal(escapes('mkdir -p ./build'), null);
  assert.equal(escapes('mkdir -p build'), null);
  assert.equal(escapes(`mkdir -p ${FOLDER}/build`), null);
  assert.equal(escapes(`cd ${FOLDER}/sub && rm -rf x`), null);
  assert.equal(escapes('cd sub && rm -rf x'), null, 'relative cd stays inside');
  assert.equal(escapes('cd sub && mkdir ../other'), null, 'dot-relative resolves against the virtual cwd');
  assert.equal(escapes('npm install playwright && npm test'), null);
  assert.equal(escapes('echo x > out.txt 2>&1'), null, 'fd duplication is not a path');
  assert.equal(escapes('npm test > /dev/null 2>&1'), null);
  assert.equal(escapes('cat x | tee out.txt'), null);
});

test('URLs and outside binaries are not write targets', () => {
  assert.equal(escapes('curl https://example.com/path/file'), null);
  assert.equal(escapes('git clone https://github.com/a/b'), null);
  assert.equal(escapes('/opt/homebrew/bin/node script.js'), null);
  assert.equal(escapes('/usr/bin/env python3 -m pytest'), null);
  assert.equal(escapes('npx --yes /opt/tools/cli --flag'), null);
});

test('the folder itself counts as inside; a sibling with a shared prefix does not', () => {
  assert.equal(escapes(`mkdir ${FOLDER}`), null);
  assert.ok(escapes(`mkdir ${FOLDER}-backup`));
  assert.ok(escapes(`mkdir ${path.join(os.homedir(), 'elsewhere')}`));
});

// ---------------------------------------------------------------------------
// allowed extra roots — the human's per-run path grants
// ---------------------------------------------------------------------------

test('a command under an allowed root does not escape', () => {
  assert.equal(bashEscapesFolder(`cd ${ROOT} && ls`, FOLDER, [ROOT]), null);
  assert.equal(bashEscapesFolder(`mkdir -p ${ROOT}/node_modules && cd ${ROOT} && npm install playwright`, FOLDER, [ROOT]), null);
  assert.equal(bashEscapesFolder(`cd ${ROOT} && mkdir sub && cd sub && touch a`, FOLDER, [ROOT]), null, 'virtual cwd inside the root stays inside');
  assert.equal(bashEscapesFolder(`mkdir ${ROOT}`, FOLDER, new Set([ROOT])), null, 'the root itself counts; any Iterable works');
});

test('a sibling outside path still escapes despite the root', () => {
  assert.ok(bashEscapesFolder('cd /tmp/other', FOLDER, [ROOT]));
  assert.ok(bashEscapesFolder(`mkdir ${ROOT}-2`, FOLDER, [ROOT]), 'shared prefix is not containment');
  assert.ok(bashEscapesFolder('cd /tmp', FOLDER, [ROOT]), 'the PARENT of a root is not granted');
  assert.ok(bashEscapesFolder(`cd ${ROOT} && cd .. && touch x`, FOLDER, [ROOT]), 'walking back out of the root escapes');
});

test('a file write under the root does not escape', () => {
  assert.equal(bashEscapesFolder(`echo hi > ${ROOT}/out.txt`, FOLDER, [ROOT]), null);
  assert.equal(bashEscapesFolder(`npm test 2>> ${ROOT}/err.log`, FOLDER, [ROOT]), null);
  assert.equal(bashEscapesFolder(`sed -i "s/a/b/" ${ROOT}/f`, FOLDER, [ROOT]), null);
  assert.ok(bashEscapesFolder('echo hi > /tmp/out.txt', FOLDER, [ROOT]), 'outside the root still prompts');
});

test('operators inside quotes are text: a perl program with => is not a redirect', () => {
  // The exact shape that put an approval card in front of an in-folder edit:
  // `=>/` inside the single-quoted program read as `>` + the path `/…`.
  assert.equal(bashEscapesFolder(`perl -0pi -e 's/\\.filter\\(\\(\\[a, b\\]\\) =>/.filter(([a]) =>/' ${ROOT}/x.tsx`, FOLDER, [ROOT]), null);
  assert.equal(bashEscapesFolder(`set -e; D=src/f; perl -0pi -e 's/ a,\\n b,/ a,/' $D/one.tsx; perl -0pi -e 's/x =>/y/' $D/two.tsx`, FOLDER, [ROOT]), null);
  assert.equal(bashEscapesFolder('echo "a > b; c | d & e" && echo \'x>/etc/passwd\'', FOLDER, [ROOT]), null);
  assert.equal(bashEscapesFolder(`git commit -m "fix: handle a > b" ${ROOT}`, FOLDER, [ROOT]), null);
  // A real redirect next to a quoted one is still seen, with its real text.
  assert.deepEqual(bashEscape('echo "x > y" > /tmp/out.txt', FOLDER), {
    reason: 'echo "x > y" > /tmp/out.txt — redirects output outside the mission folder', path: '/tmp/out.txt', grant: '/tmp',
  });
  // Quoted paths still resolve: the mask touches operators, not text.
  assert.ok(bashEscapesFolder('rm -rf "/opt/homebrew"', FOLDER, [ROOT]));
  // A quoted path with spaces is one token now, so it resolves and is judged.
  assert.equal(bashEscape(`echo hi > "/tmp/o u t.txt"`, FOLDER)!.path, '/tmp/o u t.txt');
  assert.equal(bashEscapesFolder(`echo hi > "${ROOT}/o u t.txt"`, FOLDER, [ROOT]), null);
});

test('a shell -c body is analysed as a command, so quoting cannot hide a cd', () => {
  assert.ok(bashEscapesFolder(`sh -c 'cd /tmp && npm install'`, FOLDER, [ROOT]));
  assert.match(bashEscapesFolder(`bash -c "mkdir -p /tmp/x/y"`, FOLDER, [ROOT])!, /creates a path outside/);
  assert.equal(bashEscapesFolder(`sh -c 'npm test && echo ok'`, FOLDER, [ROOT]), null);
  assert.equal(bashEscape(`bash -c 'cd /tmp/x'`, FOLDER)!.grant, '/tmp/x');
});

test('bashEscape carries the offending path and the directory to grant', () => {
  // Directory-ish targets: the path itself is the grant.
  assert.deepEqual(bashEscape('cd /tmp/x && ls', FOLDER), {
    reason: 'cd /tmp/x — writes after this land outside the mission folder', path: '/tmp/x', grant: '/tmp/x',
  });
  assert.deepEqual(bashEscape('mkdir -p /tmp/x/y', FOLDER), {
    reason: 'mkdir -p /tmp/x/y — creates a path outside the mission folder', path: '/tmp/x/y', grant: '/tmp/x/y',
  });
  assert.deepEqual(bashEscape('tar -xzf a.tgz -C /tmp/out', FOLDER), {
    reason: 'tar -xzf a.tgz -C /tmp/out — extracts into a path outside the mission folder', path: '/tmp/out', grant: '/tmp/out',
  });
  assert.equal(bashEscape('npm install --prefix=/tmp/x playwright', FOLDER)!.grant, '/tmp/x');
  assert.equal(bashEscape('git clone https://github.com/a/b /tmp/b', FOLDER)!.grant, '/tmp/b');
  assert.equal(bashEscape('rm -rf /opt/homebrew', FOLDER)!.grant, '/opt/homebrew', 'rm grants the removed tree, not its parent');
  // File targets: the parent directory is the grant.
  assert.deepEqual(bashEscape('echo hi > /tmp/x/out.txt', FOLDER), {
    reason: 'echo hi > /tmp/x/out.txt — redirects output outside the mission folder', path: '/tmp/x/out.txt', grant: '/tmp/x',
  });
  assert.equal(bashEscape('touch /tmp/x/a', FOLDER)!.grant, '/tmp/x');
  assert.equal(bashEscape('sed -i "s/a/b/" /tmp/x/f', FOLDER)!.grant, '/tmp/x');
  assert.equal(bashEscape('curl -o /tmp/x/f https://example.com/f', FOLDER)!.grant, '/tmp/x');
  assert.equal(bashEscape('cp a /tmp/x/f', FOLDER)!.grant, '/tmp/x', 'a destination without a trailing slash is a file');
  assert.equal(bashEscape('cp a /tmp/x/', FOLDER)!.grant, '/tmp/x', 'a destination spelled as a directory is one');
  assert.equal(bashEscape('cd sub && mkdir ../../x', FOLDER)!.path, '/Users/x/x', 'path is resolved against the virtual cwd');
  assert.equal(bashEscape('cat /etc/hosts', FOLDER), null);
});

// ---------------------------------------------------------------------------
// makePolicy wiring
// ---------------------------------------------------------------------------

// An outside path that is NOT a temp directory. The wiring tests below need a
// path that reaches the ask path; anything under /tmp (the live bug's
// /tmp/foreman-verify included) is now denied with a redirect before it can
// ask, and has its own tests at the end of this section.
const OUTSIDE = '/Users/x/foreman-verify';

function recordingHooks() {
  const asks: Array<{ toolName: string; title?: string; description?: string; escapedPath?: string }> = [];
  const registered: PendingPermission[] = [];
  const allows: string[] = [];
  const denies: Array<{ toolName: string; reason: string }> = [];
  const hooks: PolicyHooks = {
    onAutoAllow: (_agent, toolName) => { allows.push(toolName); },
    onAutoDeny: (_agent, toolName, reason) => { denies.push({ toolName, reason }); },
    onAsk: (_agent, _id, req) => {
      asks.push({ toolName: req.toolName, title: req.title, description: req.description, escapedPath: req.escapedPath });
    },
    register: (_id, pending) => { registered.push(pending); },
    unregister: () => true,
  };
  return { hooks, asks, allows, denies, registered };
}

function opts(signal: AbortSignal) {
  return { signal, toolUseID: 'tu_1' } as unknown as Parameters<ReturnType<typeof makePolicy>>[2];
}

/** Raise an ask through the policy, then settle it via abort (no human here). */
async function askAndAbort(policy: ReturnType<typeof makePolicy>, toolName: string, input: Record<string, unknown>) {
  const ac = new AbortController();
  const pending = policy(toolName, input, opts(ac.signal));
  ac.abort();
  return (await pending)!;
}

test('makePolicy: an escaping Bash command reaches onAsk even when Bash is allowed by policy AND granted for the run', async () => {
  const { hooks, asks, allows } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(['Bash']), new Set(), hooks, { toolPolicy: { Bash: 'allow' } });
  const ac = new AbortController();

  const pending = policy('Bash', { command: `cd ${OUTSIDE} && npm install playwright` }, opts(ac.signal));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].toolName, 'Bash');
  assert.equal(asks[0].title, 'Shell command leaves the mission folder');
  assert.equal(asks[0].description,
    `cd ${OUTSIDE} — writes after this land outside the mission folder. Path: ${OUTSIDE}. ${ESCAPE_GRANT_HINT}`);
  assert.ok(asks[0].description!.endsWith(
    'Approve "always" to allow this path for the rest of the run; other paths outside the folder will still ask.'));
  assert.equal(allows.length, 0);

  ac.abort(); // no human here; the abort path settles the promise
  const result = (await pending)!;
  assert.equal(result.behavior, 'deny');
});

test('makePolicy: a read-only Bash command on an outside path is still auto-allowed', async () => {
  const { hooks, asks, allows } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(), new Set(), hooks);
  const ac = new AbortController();
  const result = (await policy('Bash', { command: 'cat /etc/hosts && ls ~/.foreman' }, opts(ac.signal)))!;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(allows, ['Bash']);
  assert.equal(asks.length, 0);
});

test('makePolicy: Write outside the folder prompts regardless of grants (the rule Bash now mirrors)', async () => {
  const { hooks, asks } = recordingHooks();
  const policy = makePolicy('worker', FOLDER, new Set(['Write']), new Set(), hooks, { toolPolicy: { Write: 'allow' } });
  const result = await askAndAbort(policy, 'Write', { file_path: `${OUTSIDE}/out.txt`, content: '' });
  assert.equal(asks.length, 1);
  assert.equal(result.behavior, 'deny');
});

test('makePolicy: escapedPath reaches onAsk and the registered pending for an escaping Bash command', async () => {
  const { hooks, asks, registered } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(), new Set(), hooks);
  await askAndAbort(policy, 'Bash', { command: `cd ${OUTSIDE} && npm install playwright` });
  assert.equal(asks[0].escapedPath, OUTSIDE);
  assert.equal(registered[0].escapedPath, OUTSIDE);
  assert.equal(registered[0].toolName, 'Bash');

  await askAndAbort(policy, 'Bash', { command: `echo hi > ${OUTSIDE}/out.txt` });
  assert.equal(asks[1].escapedPath, OUTSIDE, 'a file target grants its directory');
});

test('makePolicy: escapedPath for an outside Write is the directory, not the file', async () => {
  const { hooks, asks, registered } = recordingHooks();
  const policy = makePolicy('worker', FOLDER, new Set(), new Set(), hooks);
  await askAndAbort(policy, 'Write', { file_path: `${OUTSIDE}/out.txt`, content: '' });
  assert.equal(asks[0].escapedPath, OUTSIDE);
  assert.equal(registered[0].escapedPath, OUTSIDE);
  assert.equal(asks[0].title, 'File edit leaves the mission folder');
  assert.ok(asks[0].description!.endsWith(ESCAPE_GRANT_HINT));

  await askAndAbort(policy, 'Edit', { file_path: `${OUTSIDE}/sub/../a.ts`, old_string: '', new_string: '' });
  assert.equal(asks[1].escapedPath, OUTSIDE, 'resolved before dirname');
});

test('makePolicy: escapedPath is absent on an ordinary (non-escape) ask', async () => {
  const { hooks, asks, registered } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(), new Set(), hooks, { toolPolicy: { Bash: 'ask' } });
  await askAndAbort(policy, 'Bash', { command: 'npm test' });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].escapedPath, undefined);
  assert.equal(registered[0].escapedPath, undefined);
});

test('makePolicy: granting the escapedPath auto-allows the same command next time; a different outside path still asks', async () => {
  const { hooks, asks, allows, registered } = recordingHooks();
  const runAllowed = new Set<string>();
  const allowedRoots = new Set<string>();
  const policy = makePolicy('director', FOLDER, runAllowed, allowedRoots, hooks);
  const command = `cd ${OUTSIDE} && npm install playwright`;

  // First time: the card is raised and names the directory to grant.
  await askAndAbort(policy, 'Bash', { command });
  assert.equal(asks.length, 1);
  // The orchestrator's side of the contract: allow_always on a pending WITH
  // escapedPath adds the path, not the tool.
  allowedRoots.add(registered[0].escapedPath!);
  assert.equal(runAllowed.size, 0);

  // Second time: the same command, and its siblings under the root, run silently.
  const ac = new AbortController();
  assert.equal((await policy('Bash', { command }, opts(ac.signal)))!.behavior, 'allow');
  assert.equal((await policy('Bash', { command: `mkdir -p ${OUTSIDE}/dist && echo x > ${OUTSIDE}/dist/out.txt` }, opts(ac.signal)))!.behavior, 'allow');
  assert.equal((await policy('Write', { file_path: `${OUTSIDE}/index.js`, content: '' }, opts(ac.signal)))!.behavior, 'allow',
    'file tools honour the same root');
  assert.deepEqual(allows, ['Bash', 'Bash', 'Write']);
  assert.equal(asks.length, 1);

  // A different outside path is not covered by the grant.
  await askAndAbort(policy, 'Bash', { command: 'cd /Users/x/other && npm install' });
  assert.equal(asks.length, 2);
  assert.equal(asks[1].escapedPath, '/Users/x/other');
  await askAndAbort(policy, 'Write', { file_path: '/Users/x/other/x.txt', content: '' });
  assert.equal(asks.length, 3);
  assert.equal(asks[2].escapedPath, '/Users/x/other');
});

test('makePolicy: runAllowed.has("Bash") alone still does NOT bypass an escape', async () => {
  const { hooks, asks, allows } = recordingHooks();
  const allowedRoots = new Set<string>();
  const policy = makePolicy('director', FOLDER, new Set(['Bash', 'Write']), allowedRoots, hooks);
  await askAndAbort(policy, 'Bash', { command: `cd ${OUTSIDE} && npm install playwright` });
  await askAndAbort(policy, 'Write', { file_path: `${OUTSIDE}/a.txt`, content: '' });
  assert.equal(asks.length, 2, 'a tool grant is not a path grant');
  assert.equal(allows.length, 0);
  assert.equal(allowedRoots.size, 0, 'the policy never mutates the caller\'s set');
});

// ---------------------------------------------------------------------------
// Temp directories: denied with a redirect, never asked
// ---------------------------------------------------------------------------

test('tempRoots covers /tmp, /private/tmp, $TMPDIR and os.tmpdir() in both macOS spellings', () => {
  const roots = tempRoots({ TMPDIR: '/var/folders/ab/T/' });
  for (const r of ['/tmp', '/private/tmp', '/var/folders/ab/T', '/private/var/folders/ab/T', os.tmpdir()]) {
    assert.ok(roots.includes(path.resolve(r)), `${r} missing from ${roots.join(', ')}`);
  }
  assert.ok(isTempPath('/tmp/foreman-verify/out.txt'));
  assert.ok(isTempPath('/private/tmp/x'));
  assert.ok(isTempPath(path.join(os.tmpdir(), 'x')));
  assert.equal(isTempPath('/tmpfoo/x'), false, 'shared prefix is not containment');
  assert.equal(isTempPath('/Users/x/other-repo/f'), false);
});

test('makePolicy: a Bash write into /tmp is denied with a redirect and never reaches onAsk', async () => {
  const { hooks, asks, denies, registered } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(['Bash']), new Set(), hooks, { toolPolicy: { Bash: 'allow' } });
  const ac = new AbortController();
  // The real-world shape: the playwright install that started all this.
  const result = (await policy('Bash', { command: 'mkdir -p /tmp/foreman-verify && cd /tmp/foreman-verify && npm install playwright' }, opts(ac.signal)))!;
  assert.equal(result.behavior, 'deny');
  assert.equal((result as { message: string }).message,
    `Denied: /tmp/foreman-verify is outside the mission folder. Scratch work belongs under ${FOLDER}/${WORK_DIR}/ — ` +
    'it is gitignored and keeps the project root clean without leaving the project. Redo this there.');
  assert.equal(asks.length, 0, 'no card');
  assert.equal(registered.length, 0, 'nothing pending for a human');
  assert.equal(denies.length, 1);
  assert.equal(denies[0].toolName, 'Bash');
  assert.match(denies[0].reason, /\.foreman\/work\//);

  assert.equal((await policy('Bash', { command: 'cd /tmp/x' }, opts(ac.signal)))!.behavior, 'deny');
  assert.equal((await policy('Bash', { command: `echo hi > ${path.join(os.tmpdir(), 'out.txt')}` }, opts(ac.signal)))!.behavior, 'deny');
  assert.equal(denies.length, 3);
});

test('makePolicy: Write/Edit into /private/tmp are denied with the redirect; a non-temp outside path still asks', async () => {
  const { hooks, asks, denies } = recordingHooks();
  const policy = makePolicy('worker', FOLDER, new Set(), new Set(), hooks);
  const ac = new AbortController();
  const w = (await policy('Write', { file_path: '/private/tmp/x/f', content: '' }, opts(ac.signal)))!;
  assert.equal(w.behavior, 'deny');
  assert.equal((w as { message: string }).message, tempDirDenial('/private/tmp/x/f', FOLDER));
  const e = (await policy('Edit', { file_path: '/tmp/x/f', old_string: '', new_string: '' }, opts(ac.signal)))!;
  assert.equal(e.behavior, 'deny');
  assert.equal(asks.length, 0);
  assert.deepEqual(denies.map((d) => d.toolName), ['Write', 'Edit']);

  // Everything outside that is not a temp dir keeps the ask path — a sibling
  // repo might be exactly where the mission needs to go.
  await askAndAbort(policy, 'Write', { file_path: '/Users/x/other-repo/f', content: '' });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].escapedPath, '/Users/x/other-repo');
  assert.equal(denies.length, 2);
});

test('makePolicy: reads of temp paths are untouched, and a temp path the human already granted is inside', async () => {
  const { hooks, asks, allows, denies } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(), new Set(['/tmp/granted']), hooks);
  const ac = new AbortController();
  assert.equal((await policy('Bash', { command: 'ls /tmp && cat /tmp/x/log' }, opts(ac.signal)))!.behavior, 'allow');
  // A root granted before this rule landed (or on a resumed run) is a
  // decision the human already made; the deny class never overrides a grant.
  assert.equal((await policy('Bash', { command: 'touch /tmp/granted/a' }, opts(ac.signal)))!.behavior, 'allow');
  assert.equal((await policy('Write', { file_path: '/tmp/granted/b', content: '' }, opts(ac.signal)))!.behavior, 'allow');
  assert.equal(asks.length, 0);
  assert.equal(denies.length, 0);
  assert.deepEqual(allows, ['Bash', 'Bash', 'Write']);
});

test('makePolicy: onAutoDeny is optional — the deny still happens without a listener', async () => {
  const { hooks } = recordingHooks();
  delete hooks.onAutoDeny;
  const policy = makePolicy('director', FOLDER, new Set(), new Set(), hooks);
  const ac = new AbortController();
  assert.equal((await policy('Write', { file_path: '/tmp/f', content: '' }, opts(ac.signal)))!.behavior, 'deny');
});
