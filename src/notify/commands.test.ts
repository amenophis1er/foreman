import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandHome, parseCommand, projectsRoot, slug } from './commands.js';

test('parseCommand: one shape per command, bot suffix tolerated, junk is null', () => {
  assert.deepEqual(parseCommand('/help'), { cmd: 'help' });
  assert.deepEqual(parseCommand('/start'), { cmd: 'help' });
  assert.deepEqual(parseCommand('/projects'), { cmd: 'projects' });
  assert.deepEqual(parseCommand('/new My Shop'), { cmd: 'new', name: 'My Shop' });
  assert.deepEqual(parseCommand('/plan@ForemanBot test-4 add a footer\nwith links'), { cmd: 'plan', project: 'test-4', text: 'add a footer\nwith links' });
  assert.deepEqual(parseCommand('/run lp1 ship it'), { cmd: 'run', project: 'lp1', text: 'ship it' });
  assert.deepEqual(parseCommand('/stop'), { cmd: 'stop' });
  assert.deepEqual(parseCommand('/stop lp1'), { cmd: 'stop', project: 'lp1' });
  assert.deepEqual(parseCommand('/schedules'), { cmd: 'schedules' });
  assert.deepEqual(parseCommand('/schedules@ForemanBot lp1'), { cmd: 'schedules', project: 'lp1' });
  assert.equal(parseCommand('/plan test-4'), null);
  assert.equal(parseCommand('/new'), null);
  assert.equal(parseCommand('/dance'), null);
  assert.equal(parseCommand('just words'), null);
});

test('slug and roots', () => {
  assert.equal(slug('My New App!'), 'my-new-app');
  assert.equal(slug('  ../evil  '), 'evil');
  assert.equal(expandHome('~/Projects', '/home/a'), '/home/a/Projects');
  assert.equal(projectsRoot(undefined, '/home/a'), '/home/a/Projects');
  assert.equal(projectsRoot('~/Code', '/home/a'), '/home/a/Code');
  assert.equal(projectsRoot('/srv/work', '/home/a'), '/srv/work');
  assert.equal(projectsRoot('rel', '/home/a'), '/home/a/rel');
});

test('/fleet talks to the front desk, with or without words', () => {
  assert.deepEqual(parseCommand('/fleet how is everything going?'), { cmd: 'fleet', text: 'how is everything going?' });
  assert.deepEqual(parseCommand('/f'), { cmd: 'fleet', text: '' });
  assert.deepEqual(parseCommand('/fleet@ForemanBot'), { cmd: 'fleet', text: '' });
});
