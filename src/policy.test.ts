/**
 * Permission policy tests — the Bash folder-boundary heuristic and its wiring
 * into `makePolicy`. Nothing here touches the filesystem: paths are strings
 * fed to a pure function, and the policy hooks are recorded in memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { bashEscapesFolder, makePolicy, type PolicyHooks } from './policy.js';

const FOLDER = '/Users/x/proj';
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
// makePolicy wiring
// ---------------------------------------------------------------------------

function recordingHooks() {
  const asks: Array<{ toolName: string; title?: string; description?: string }> = [];
  const allows: string[] = [];
  const hooks: PolicyHooks = {
    onAutoAllow: (_agent, toolName) => { allows.push(toolName); },
    onAsk: (_agent, _id, req) => { asks.push({ toolName: req.toolName, title: req.title, description: req.description }); },
    register: () => {},
    unregister: () => true,
  };
  return { hooks, asks, allows };
}

function opts(signal: AbortSignal) {
  return { signal, toolUseID: 'tu_1' } as unknown as Parameters<ReturnType<typeof makePolicy>>[2];
}

test('makePolicy: an escaping Bash command reaches onAsk even when Bash is allowed by policy AND granted for the run', async () => {
  const { hooks, asks, allows } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(['Bash']), hooks, { toolPolicy: { Bash: 'allow' } });
  const ac = new AbortController();

  const pending = policy('Bash', { command: 'cd /tmp && npm install playwright' }, opts(ac.signal));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].toolName, 'Bash');
  assert.equal(asks[0].title, 'Shell command leaves the mission folder');
  assert.equal(asks[0].description, 'cd /tmp — writes after this land outside the mission folder');
  assert.equal(allows.length, 0);

  ac.abort(); // no human here; the abort path settles the promise
  const result = (await pending)!;
  assert.equal(result.behavior, 'deny');
});

test('makePolicy: a read-only Bash command on an outside path is still auto-allowed', async () => {
  const { hooks, asks, allows } = recordingHooks();
  const policy = makePolicy('director', FOLDER, new Set(), hooks);
  const ac = new AbortController();
  const result = (await policy('Bash', { command: 'cat /etc/hosts && ls ~/.foreman' }, opts(ac.signal)))!;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(allows, ['Bash']);
  assert.equal(asks.length, 0);
});

test('makePolicy: Write outside the folder prompts regardless of grants (the rule Bash now mirrors)', async () => {
  const { hooks, asks } = recordingHooks();
  const policy = makePolicy('worker', FOLDER, new Set(['Write']), hooks, { toolPolicy: { Write: 'allow' } });
  const ac = new AbortController();
  const pending = policy('Write', { file_path: '/tmp/out.txt', content: '' }, opts(ac.signal));
  assert.equal(asks.length, 1);
  ac.abort();
  assert.equal((await pending)!.behavior, 'deny');
});
