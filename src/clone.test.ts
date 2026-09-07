import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainGitFailure, looksLikeRepoUrl, parseRepoUrl } from './clone.js';

test('parseRepoUrl: the forms people paste all name the same repository', () => {
  for (const s of ['https://github.com/acme/widget', 'https://github.com/acme/widget.git', 'https://github.com/acme/widget/', 'https://github.com/acme/widget/tree/main/src', 'acme/widget']) {
    assert.deepEqual(parseRepoUrl(s), { url: 'https://github.com/acme/widget.git', name: 'widget', host: 'github.com' }, s);
  }
  assert.deepEqual(parseRepoUrl('git@github.com:acme/widget.git'), { url: 'git@github.com:acme/widget.git', name: 'widget', host: 'github.com' });
  assert.deepEqual(parseRepoUrl('git@gitlab.com:group/sub/widget'), { url: 'git@gitlab.com:group/sub/widget.git', name: 'widget', host: 'gitlab.com' });
  assert.deepEqual(parseRepoUrl('ssh://git@bitbucket.org:7999/proj/widget.git'), { url: 'ssh://git@bitbucket.org:7999/proj/widget.git', name: 'widget', host: 'bitbucket.org' });
});

test('parseRepoUrl: not a repository', () => {
  for (const s of ['', 'https://github.com/acme', '/Users/me/Projects/x', '~/Projects/x', './x', 'just words here', 'https://example.com']) {
    assert.equal(parseRepoUrl(s), null, s);
  }
});

test('looksLikeRepoUrl separates repositories from folder paths for the shared link verbs', () => {
  assert.equal(looksLikeRepoUrl('https://github.com/acme/widget'), true);
  assert.equal(looksLikeRepoUrl('git@github.com:acme/widget.git'), true);
  assert.equal(looksLikeRepoUrl('acme/widget'), true);
  assert.equal(looksLikeRepoUrl('~/Projects/widget'), false);
  assert.equal(looksLikeRepoUrl('/Users/me/widget'), false);
  assert.equal(looksLikeRepoUrl('./widget'), false);
});

test('explainGitFailure turns stderr into one sentence a person can act on', () => {
  const ref = { url: 'https://github.com/acme/secret.git', name: 'secret', host: 'github.com' };
  assert.match(explainGitFailure('Cloning into...\nfatal: could not read Username for https://github.com: terminal prompts disabled', ref), /could not authenticate to github.com/);
  assert.match(explainGitFailure('ERROR: Repository not found.\nfatal: Could not read from remote repository.', ref), /not found/);
  assert.match(explainGitFailure("fatal: unable to access 'x': Could not resolve host: github.com", ref), /Could not reach github.com/);
  assert.match(explainGitFailure('fatal: something odd', ref), /git clone failed: something odd/);
});
