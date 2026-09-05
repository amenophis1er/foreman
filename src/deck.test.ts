import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { captureBaseline, deckFor, handleDeckRoute, loadBaseline, readArtifact, type Deck, type DeckFile } from './deck.js';

// Every test gets its own folder under os.tmpdir(), which is not inside a git
// work tree, so the "no git" cases really exercise the snapshot path.
async function tmp(prefix = 'foreman-deck-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [
      // A hermetic identity: no dependency on the developer's global config,
      // and no signing so CI machines without a key can commit.
      '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
      ...args,
    ], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function touch(file: string, whenMs: number): Promise<void> {
  await utimes(file, whenMs / 1000, whenMs / 1000);
}

const byPath = (deck: Deck): Record<string, DeckFile> =>
  Object.fromEntries(deck.files.map((f) => [f.path, f]));

// ---------------------------------------------------------------------------
// git baseline
// ---------------------------------------------------------------------------

test('git folder: modified, added and deleted files are attributed; a pre-dirty file is flagged preexisting', async () => {
  const folder = await tmp();
  try {
    await git(folder, 'init', '-q');
    await writeFile(path.join(folder, 'a.txt'), 'one\ntwo\nthree\n');
    await writeFile(path.join(folder, 'c.txt'), 'gone\nsoon\n');
    await writeFile(path.join(folder, 'dirty.txt'), 'clean\n');
    await git(folder, 'add', '.');
    await git(folder, 'commit', '-q', '-m', 'base');
    // Dirtied before the run starts: the run must not be blamed for it.
    await writeFile(path.join(folder, 'dirty.txt'), 'dirty before\n');

    const runId = '1788635675338-e8e5a4a8';
    const baseline = await captureBaseline(folder, runId);
    assert.equal(baseline.kind, 'git');
    if (baseline.kind !== 'git') throw new Error('unreachable');
    assert.match(baseline.head ?? '', /^[0-9a-f]{40}$/);
    assert.deepEqual(baseline.dirty, ['dirty.txt']);
    assert.deepEqual(await loadBaseline(folder, runId), baseline);

    // The run's work.
    await writeFile(path.join(folder, 'a.txt'), 'one\n2\nthree\nfour\n');
    await writeFile(path.join(folder, 'b.txt'), 'new file\nsecond line\n');
    await unlink(path.join(folder, 'c.txt'));
    await writeFile(path.join(folder, 'dirty.txt'), 'dirty before\nand during\n');
    await writeFile(path.join(folder, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));

    const deck = await deckFor(folder, runId);
    assert.equal(deck.baseline.kind, 'git');
    assert.equal(deck.baseline.head, baseline.head);
    const f = byPath(deck);

    assert.equal(f['a.txt'].status, 'modified');
    assert.equal(f['a.txt'].additions, 2);
    assert.equal(f['a.txt'].deletions, 1);
    assert.match(f['a.txt'].diff ?? '', /^-two$/m);
    assert.match(f['a.txt'].diff ?? '', /^\+2$/m);
    assert.equal(f['a.txt'].preexisting, undefined);

    assert.equal(f['b.txt'].status, 'added');
    assert.equal(f['b.txt'].additions, 2);
    assert.equal(f['b.txt'].deletions, 0);
    assert.match(f['b.txt'].diff ?? '', /^\+new file$/m);

    assert.equal(f['c.txt'].status, 'deleted');
    assert.equal(f['c.txt'].deletions, 2);
    assert.match(f['c.txt'].diff ?? '', /^-gone$/m);

    assert.equal(f['dirty.txt'].status, 'modified');
    assert.equal(f['dirty.txt'].preexisting, true);
    assert.match(deck.note ?? '', /preexisting/);

    assert.equal(f['bin.dat'].status, 'added');
    assert.equal(f['bin.dat'].binary, true);
    assert.equal(f['bin.dat'].diff, undefined);

    assert.equal(deck.totals.files, 5);
    // dirty.txt is diffed against HEAD, so its pre-run edit is counted too —
    // that is precisely what the preexisting flag warns about.
    assert.equal(deck.totals.additions, 2 + 2 + 2);
    assert.equal(deck.totals.deletions, 1 + 2 + 1);
    // The baseline lives under .foreman/work, which git never sees as a change.
    assert.ok(!Object.keys(f).some((p) => p.startsWith('.foreman/')), 'baseline leaked into the diff');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('git folder with no commits yet: every tracked and untracked file is added', async () => {
  const folder = await tmp();
  try {
    await git(folder, 'init', '-q');
    const baseline = await captureBaseline(folder, 'r1');
    assert.equal(baseline.kind, 'git');
    if (baseline.kind === 'git') assert.equal(baseline.head, null);
    await writeFile(path.join(folder, 'x.txt'), 'x\n');
    await git(folder, 'add', 'x.txt');
    await writeFile(path.join(folder, 'y.txt'), 'y\n');
    const deck = await deckFor(folder, 'r1');
    const f = byPath(deck);
    assert.equal(f['x.txt'].status, 'added');
    assert.equal(f['y.txt'].status, 'added');
    assert.equal(f['y.txt'].additions, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// snapshot baseline
// ---------------------------------------------------------------------------

test('snapshot folder: statuses from hashes, real diffs from the kept copies, big files skipped', async () => {
  const folder = await tmp();
  try {
    await writeFile(path.join(folder, 'keep.txt'), 'same\n');
    await writeFile(path.join(folder, 'mod.txt'), 'alpha\nbeta\ngamma\n');
    await writeFile(path.join(folder, 'del.txt'), 'bye\nbye\nbye\n');
    await writeFile(path.join(folder, 'huge-before.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
    await mkdir(path.join(folder, 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(folder, 'node_modules', 'dep', 'index.js'), 'ignored\n');

    const baseline = await captureBaseline(folder, 'snap');
    assert.equal(baseline.kind, 'snapshot');
    if (baseline.kind !== 'snapshot') throw new Error('unreachable');
    assert.deepEqual(Object.keys(baseline.files).sort(), ['del.txt', 'keep.txt', 'mod.txt']);

    await writeFile(path.join(folder, 'mod.txt'), 'alpha\nBETA\ngamma\ndelta\n');
    await writeFile(path.join(folder, 'new.txt'), 'n1\nn2\n');
    await unlink(path.join(folder, 'del.txt'));
    await writeFile(path.join(folder, 'huge-after.bin'), Buffer.alloc(3 * 1024 * 1024, 2));
    // Touched but unchanged: must not show up.
    await touch(path.join(folder, 'keep.txt'), Date.now() + 5_000);

    const deck = await deckFor(folder, 'snap');
    assert.equal(deck.baseline.kind, 'snapshot');
    assert.equal(deck.baseline.at, baseline.at);
    const f = byPath(deck);
    assert.deepEqual(Object.keys(f).sort(), ['del.txt', 'mod.txt', 'new.txt']);

    assert.equal(f['mod.txt'].status, 'modified');
    assert.equal(f['mod.txt'].additions, 2);
    assert.equal(f['mod.txt'].deletions, 1);
    assert.match(f['mod.txt'].diff ?? '', /^-beta$/m);
    assert.match(f['mod.txt'].diff ?? '', /^\+BETA$/m);
    assert.match(f['mod.txt'].diff ?? '', /^@@ -1,3 \+1,4 @@$/m);

    assert.equal(f['new.txt'].status, 'added');
    const body = (f['new.txt'].diff ?? '').split('\n').filter((l) => !/^(---|\+\+\+|@@)/.test(l));
    assert.equal(body.length, 2);
    assert.ok(body.every((l) => l.startsWith('+')), `not all additions: ${body}`);

    assert.equal(f['del.txt'].status, 'deleted');
    assert.equal(f['del.txt'].deletions, 3);
    assert.match(f['del.txt'].diff ?? '', /^-bye$/m);

    assert.deepEqual(deck.totals, { files: 3, additions: 4, deletions: 4 });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('snapshot: a long diff is capped at 400 lines and flagged', async () => {
  const folder = await tmp();
  try {
    await writeFile(path.join(folder, 'long.txt'), 'x\n');
    await captureBaseline(folder, 'cap');
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await writeFile(path.join(folder, 'long.txt'), lines);
    const deck = await deckFor(folder, 'cap');
    const f = byPath(deck)['long.txt'];
    assert.equal(f.truncated, true);
    assert.equal((f.diff ?? '').split('\n').length, 400);
    assert.equal(f.additions, 1000); // counts are for the whole change, not the shown part
    assert.equal(f.deletions, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

test('artifacts: screenshots and work-dir files always, report-like files only when newer than the baseline', async () => {
  const folder = await tmp();
  try {
    await writeFile(path.join(folder, 'before.md'), '# old\n');
    const baseline = await captureBaseline(folder, 'art');
    // Pin mtimes on both sides of the baseline so the test does not depend
    // on filesystem timestamp granularity.
    await touch(path.join(folder, 'before.md'), baseline.at - 10_000);
    await mkdir(path.join(folder, 'screenshots'));
    await writeFile(path.join(folder, 'screenshots', 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(folder, '.foreman', 'work', 'http.log'), 'GET / 200\n');
    await writeFile(path.join(folder, '.foreman', 'work', '.gitignore'), '*\n');
    await writeFile(path.join(folder, 'notes.md'), '# notes\n');
    await writeFile(path.join(folder, 'report.pdf'), '%PDF-1.4\n');
    await writeFile(path.join(folder, 'code.ts'), 'export {};\n'); // not an artifact extension
    for (const rel of ['screenshots/x.png', '.foreman/work/http.log', 'notes.md', 'report.pdf', 'code.ts']) {
      await touch(path.join(folder, rel), baseline.at + 10_000);
    }

    const deck = await deckFor(folder, 'art');
    const kinds = Object.fromEntries(deck.artifacts.map((a) => [a.path, a.kind]));
    assert.deepEqual(kinds, {
      'screenshots/x.png': 'image',
      '.foreman/work/http.log': 'text',
      'notes.md': 'text',
      'report.pdf': 'pdf',
    });
    const png = deck.artifacts.find((a) => a.path === 'screenshots/x.png');
    assert.equal(png?.size, 4);
    // Newest first.
    const times = deck.artifacts.map((a) => a.mtimeMs);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    // notes.md is also a change; the deck reports both views of it.
    assert.equal(byPath(deck)['notes.md']?.status, 'added');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('no baseline: kind none with the note, artifacts still listed', async () => {
  const folder = await tmp();
  try {
    await mkdir(path.join(folder, 'screenshots'));
    await writeFile(path.join(folder, 'screenshots', 'shot.jpg'), 'jpg');
    await writeFile(path.join(folder, 'README.md'), '# not an artifact without a baseline\n');
    const deck = await deckFor(folder, 'never-started');
    assert.equal(deck.baseline.kind, 'none');
    assert.deepEqual(deck.files, []);
    assert.equal(deck.note, 'No baseline was recorded when this run started, so changes cannot be attributed to it.');
    assert.deepEqual(deck.artifacts.map((a) => a.path), ['screenshots/shot.jpg']);
    assert.equal(deck.artifacts[0].kind, 'image');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readArtifact
// ---------------------------------------------------------------------------

test('readArtifact stays inside the folder and reports mime and size', async () => {
  const folder = await tmp();
  const outside = await tmp('foreman-deck-outside-');
  try {
    await mkdir(path.join(folder, 'screenshots'));
    await writeFile(path.join(folder, 'screenshots', 'a.png'), Buffer.alloc(10));
    await writeFile(path.join(folder, 'page.html'), '<script>alert(1)</script>');
    await writeFile(path.join(outside, 'secret.txt'), 'nope');
    await symlink(path.join(outside, 'secret.txt'), path.join(folder, 'link.txt'));
    await symlink(outside, path.join(folder, 'linkdir'));

    assert.equal(await readArtifact(folder, '../etc/passwd'), null);
    assert.equal(await readArtifact(folder, '/etc/passwd'), null);
    assert.equal(await readArtifact(folder, 'screenshots/../../etc/passwd'), null);
    assert.equal(await readArtifact(folder, 'link.txt'), null);
    assert.equal(await readArtifact(folder, 'linkdir/secret.txt'), null);
    assert.equal(await readArtifact(folder, 'screenshots'), null); // a directory
    assert.equal(await readArtifact(folder, 'missing.png'), null);
    assert.equal(await readArtifact(folder, ''), null);

    const png = await readArtifact(folder, 'screenshots/a.png');
    assert.ok(png);
    assert.equal(png.mime, 'image/png');
    assert.equal(png.size, 10);
    assert.equal(png.absPath, path.join(await import('node:fs/promises').then((m) => m.realpath(folder)), 'screenshots', 'a.png'));

    const html = await readArtifact(folder, 'page.html');
    assert.ok(html);
    assert.match(html.mime, /^text\/plain/); // never rendered as a document
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// handleDeckRoute
// ---------------------------------------------------------------------------

test('handleDeckRoute: matches only its two routes, 404s unknown runs and bad paths, streams real artifacts', async () => {
  const folder = await tmp();
  const runs: Record<string, { folder: string }> = { 'run-1': { folder } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const handled = await handleDeckRoute(req, res, url, async (id) => runs[id] ?? null);
    // A status no deck response ever uses, so the test can see "fell through".
    if (!handled) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
  try {
    await mkdir(path.join(folder, 'screenshots'));
    await writeFile(path.join(folder, 'screenshots', 'a.png'), Buffer.from('pngbytes'));
    await captureBaseline(folder, 'run-1');
    await writeFile(path.join(folder, 'made.txt'), 'hello\n');

    assert.equal((await get('/runs/run-1/events')).status, 418);
    assert.equal((await get('/runs')).status, 418);
    assert.equal((await get('/runs/nope/deck')).status, 404);
    assert.equal((await get('/runs/run%2F..%2F1/deck')).status, 404); // fails the id regex
    assert.equal((await get('/runs/run-1/artifact')).status, 404);
    assert.equal((await get('/runs/run-1/artifact?path=..%2F..%2Fetc%2Fpasswd')).status, 404);
    assert.equal((await get('/runs/run-1/artifact?path=missing.png')).status, 404);

    const deckRes = await get('/runs/run-1/deck');
    assert.equal(deckRes.status, 200);
    assert.match(deckRes.headers.get('content-type') ?? '', /application\/json/);
    const deck = await deckRes.json();
    assert.equal(deck.runId, 'run-1');
    assert.equal(deck.baseline.kind, 'snapshot');
    assert.equal(deck.files[0].path, 'made.txt');
    // made.txt is newer than the baseline and has an artifact extension, so
    // it is listed alongside the screenshot.
    assert.deepEqual(deck.artifacts.map((a: { path: string }) => a.path).sort(), ['made.txt', 'screenshots/a.png']);

    const art = await get('/runs/run-1/artifact?path=screenshots%2Fa.png');
    assert.equal(art.status, 200);
    assert.equal(art.headers.get('content-type'), 'image/png');
    assert.equal(art.headers.get('cache-control'), 'no-store');
    assert.match(art.headers.get('content-disposition') ?? '', /^inline; filename="a\.png"$/);
    assert.equal(Buffer.from(await art.arrayBuffer()).toString(), 'pngbytes');

    const post = await fetch(`http://127.0.0.1:${port}/runs/run-1/deck`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(folder, { recursive: true, force: true });
  }
});
