import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, SERVICE_COMMANDS, completionScript, detectShell, installTarget } from './completion.js';

test('every shell script names every command and the service verbs', () => {
  for (const shell of ['zsh', 'bash', 'fish'] as const) {
    const s = completionScript(shell);
    for (const [c] of COMMANDS) assert.ok(s.includes(c), `${shell} lacks ${c}`);
    for (const c of SERVICE_COMMANDS) assert.ok(s.includes(c), `${shell} lacks service ${c}`);
    const flags = shell === 'fish' ? ['-l force', '-l purge'] : ['--force', '--purge'];
    for (const f of flags) assert.ok(s.includes(f), `${shell} lacks flag ${f}`);
  }
  assert.match(completionScript('zsh'), /^#compdef foreman\n/);
  assert.match(completionScript('zsh'), /compdef _foreman foreman\n$/);
  assert.match(completionScript('bash'), /complete -F _foreman foreman\n$/);
  assert.match(completionScript('fish'), /^complete -c foreman -f\n/);
});

test('detectShell reads $SHELL and ignores anything else', () => {
  assert.equal(detectShell({ SHELL: '/bin/zsh' }), 'zsh');
  assert.equal(detectShell({ SHELL: '/opt/homebrew/bin/fish' }), 'fish');
  assert.equal(detectShell({ SHELL: '/bin/tcsh' }), null);
  assert.equal(detectShell({}), null);
});

test('installTarget: rc line for zsh and bash, a completions file for fish', () => {
  assert.deepEqual(installTarget('zsh', '/home/u'), { file: '/home/u/.zshrc', line: 'eval "$(foreman completion zsh)" # foreman completion' });
  assert.equal(installTarget('bash', '/home/u').file, '/home/u/.bashrc');
  assert.deepEqual(installTarget('fish', '/home/u'), { file: '/home/u/.config/fish/completions/foreman.fish' });
});
