/**
 * Deck — what a mission changed, and what it produced.
 *
 * The product's non-goals fix the boundary: "The deck is diff and artifacts, not a
 * file manager and not an editor. Its job is to show what this mission
 * changed, which is something your editor cannot tell you and Foreman can."
 * Everything here is read-only with respect to the user's project. The only
 * thing this module ever writes is the baseline under `<folder>/.foreman/work/`,
 * which is gitignored and already the mission's scratch area.
 *
 * How attribution works:
 *  - At run start the caller records a {@link Baseline}: for a git work tree,
 *    the HEAD sha plus the paths that were already dirty; for anything else,
 *    a hash snapshot of the folder. Without a baseline the deck cannot say
 *    what *this run* did versus what was already there, and says so instead
 *    of guessing.
 *  - {@link deckFor} compares the folder now against that baseline. In git
 *    mode git does the diffing; in snapshot mode we keep byte copies of small
 *    text files next to the baseline so a real unified diff is still possible
 *    (a hash alone can only say "changed").
 *  - Artifacts are the files a mission produces rather than edits:
 *    screenshots, logs under the work dir, and any report-like file whose
 *    mtime is newer than the baseline.
 *
 * Failure policy: {@link deckFor} never throws. A missing git binary, a folder
 * that stopped being a repo, an unreadable baseline — all degrade to
 * `baseline.kind = 'none'` with a `note` naming the failure class, and the
 * artifact list is still returned because it does not depend on git.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { WORK_DIR } from './policy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapshotEntry { size: number; mtimeMs: number; hash: string }

export type Baseline =
  | { kind: 'git'; at: number; head: string | null; dirty: string[] }
  | { kind: 'snapshot'; at: number; files: Record<string, SnapshotEntry>; truncated?: boolean };

export interface DeckFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary?: boolean;
  diff?: string;
  truncated?: boolean;
  /** The path was already dirty when the run started; the run may have touched it too. */
  preexisting?: boolean;
}

export interface DeckArtifact {
  path: string;
  kind: 'image' | 'text' | 'pdf' | 'other';
  size: number;
  mtimeMs: number;
}

export interface Deck {
  runId: string;
  baseline: { kind: 'git' | 'snapshot' | 'none'; at?: number; head?: string | null };
  files: DeckFile[];
  artifacts: DeckArtifact[];
  totals: { files: number; additions: number; deletions: number };
  note?: string;
}

// ---------------------------------------------------------------------------
// Limits — every one of these exists because the folder is the user's real
// project and can be arbitrarily large. The deck is a summary, not a mirror.
// ---------------------------------------------------------------------------

/** Files larger than this are never hashed, diffed or listed as changes. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Content-hash (and, in snapshot mode, keep a copy of) files up to this size. */
const HASH_BYTES = 512 * 1024;
/** Snapshot walk stops recording past this many files. */
const SNAPSHOT_CAP = 5_000;
/** Total bytes of text copies kept beside a snapshot baseline. */
const BLOB_BUDGET_BYTES = 32 * 1024 * 1024;
/** Changed files reported per deck. */
const FILE_CAP = 200;
/** Diff lines kept per file. */
const DIFF_LINE_CAP = 400;
/** Artifacts reported per deck. */
const ARTIFACT_CAP = 200;
/** Artifact walk gives up after this many directory entries. */
const ARTIFACT_WALK_CAP = 50_000;
/** Bytes sniffed for a NUL to decide text vs binary. */
const SNIFF_BYTES = 8 * 1024;
/** readArtifact refuses files above this. */
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** LCS table cells before the line diff falls back to whole-block replace. */
const LCS_CELL_CAP = 4_000_000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const RUN_ID_RE = /^[A-Za-z0-9-]+$/;
const NO_BASELINE_NOTE =
  'No baseline was recorded when this run started, so changes cannot be attributed to it.';

const ARTIFACT_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf', 'md', 'html', 'txt', 'log', 'json', 'csv',
]);

/** Files a run typically leaves in its work dir that a person wants to read, not download. */
const CODE_EXTS = ['yml', 'yaml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'py', 'sh', 'toml', 'xml', 'ini', 'sql', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'diff', 'patch', 'env', 'conf', 'cfg', 'lock', 'gitignore', 'txt'];

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  // HTML is served as plain text on purpose: an artifact produced by an agent
  // must never execute script in the dashboard's origin.
  html: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8',
  // Code and config read as text too. Served as plain text, never as a
  // script or stylesheet type: the deck shows work, it does not load it.
  ...Object.fromEntries(CODE_EXTS.map((e) => [e, 'text/plain; charset=utf-8'])),
};


// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function baselinePath(folder: string, runId: string): string {
  return path.join(folder, WORK_DIR, `baseline-${runId}.json`);
}
function blobDir(folder: string, runId: string): string {
  return path.join(folder, WORK_DIR, `baseline-${runId}.blobs`);
}

function ext(p: string): string {
  return path.extname(p).slice(1).toLowerCase();
}

function artifactKind(p: string): DeckArtifact['kind'] {
  const e = ext(p);
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (['md', 'html', 'txt', 'log', 'json', 'csv', ...CODE_EXTS].includes(e)) return 'text';
  return 'other';
}

function isText(buf: Buffer): boolean {
  return !buf.subarray(0, SNIFF_BYTES).includes(0);
}

/** Always forward slashes, so a deck reads the same and paths round-trip through URLs. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

/**
 * Run git with an argument vector — never a shell, because paths in the
 * user's project can contain anything. Rejects with the git stderr so the
 * caller can name the failure class in a note.
 */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      // Never let a repo hook or a pager surprise us; never prompt.
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/**
 * The repo's toplevel and the folder itself, both as real paths. Git reports
 * paths relative to the toplevel and we rebase them onto the folder, which
 * only works when neither side goes through a symlink (macOS's /var vs
 * /private/var is the everyday case).
 */
async function gitRoots(folder: string): Promise<{ top: string; folder: string } | null> {
  try {
    const top = (await git(['rev-parse', '--show-toplevel'], folder)).trim();
    return top ? { top: await realpath(top), folder: await realpath(folder) } : null;
  } catch {
    return null;
  }
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', 'HEAD'], cwd)).trim() || null;
  } catch {
    // An empty repository: rev-parse HEAD fails although the folder is a
    // perfectly good work tree. Every tracked file is then "added".
    return null;
  }
}

/**
 * `git status --porcelain=v1 -z` entries scoped to `folder`, as
 * `{ xy, path }` with paths relative to `folder`. Porcelain paths are always
 * relative to the repo root (the format ignores status.relativePaths), hence
 * the rebasing. Rename entries carry the original path as a second NUL
 * record, which is skipped.
 */
async function gitStatus(folder: string, top: string): Promise<{ xy: string; path: string }[]> {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', folder], top);
  const parts = out.split('\0');
  const entries: { xy: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const rel = relToFolder(folder, top, rec.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (rel !== null) entries.push({ xy, path: rel });
  }
  return entries;
}

function isScratch(rel: string): boolean {
  return rel === WORK_DIR || rel.startsWith(`${WORK_DIR}/`);
}

function relToFolder(folder: string, top: string, repoRel: string): string | null {
  const rel = path.relative(folder, path.join(top, repoRel));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

// ---------------------------------------------------------------------------
// Folder walk (shared by the snapshot and the artifact scan)
// ---------------------------------------------------------------------------

interface WalkOpts {
  /** Skip `.foreman/work` (the snapshot does; the artifact scan must not). */
  skipWork: boolean;
  /** Stop after this many files have been visited. */
  limit: number;
}

interface WalkFile { rel: string; abs: string; size: number; mtimeMs: number }

/**
 * Depth-first, sorted, symlink-free walk. Symlinks are skipped outright: they
 * can loop, and they can point outside the folder, and neither is something
 * a "what changed here" view should follow. Hidden directories are skipped
 * except `.foreman`, which is ours.
 */
async function walk(folder: string, opts: WalkOpts): Promise<{ files: WalkFile[]; truncated: boolean }> {
  const files: WalkFile[] = [];
  let truncated = false;
  const visit = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not this module's problem to report
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (truncated) return;
      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
      const abs = path.join(dirAbs, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith('.') && ent.name !== '.foreman') continue;
        if (opts.skipWork && rel === WORK_DIR) continue;
        await visit(abs, rel);
      } else if (ent.isFile()) {
        if (files.length >= opts.limit) { truncated = true; return; }
        try {
          const st = await stat(abs);
          files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished between readdir and stat */ }
      }
    }
  };
  await visit(folder, '');
  return { files, truncated };
}

/**
 * Snapshot identity for a file. Small files are content-hashed so a touch
 * without an edit is not a change; large ones fall back to size:mtime because
 * hashing a 2 MB asset on every run start is not worth the precision.
 * Returns the content too when it was read, so callers can keep a copy.
 */
async function fingerprint(f: WalkFile): Promise<{ hash: string; content?: Buffer }> {
  if (f.size > HASH_BYTES) return { hash: `${f.size}:${Math.round(f.mtimeMs)}` };
  const content = await readFile(f.abs);
  return { hash: crypto.createHash('sha1').update(content).digest('hex'), content };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * Record what `folder` looks like right now so {@link deckFor} can later say
 * what changed. Call once, when a run *starts* — never on resume, since a
 * resumed run's earlier turns already changed the folder and re-baselining
 * would erase them from the deck.
 */
export async function captureBaseline(folder: string, runId: string): Promise<Baseline> {
  const at = Date.now();
  const roots = await gitRoots(folder);
  let baseline: Baseline;
  if (roots) {
    const head = await gitHead(roots.top);
    const dirty = (await gitStatus(roots.folder, roots.top)).map((e) => e.path);
    baseline = { kind: 'git', at, head, dirty };
  } else {
    baseline = await snapshot(folder, runId, at);
  }
  await writeJsonAtomic(baselinePath(folder, runId), baseline);
  return baseline;
}

async function snapshot(folder: string, runId: string, at: number): Promise<Baseline> {
  const { files: walked, truncated } = await walk(folder, { skipWork: true, limit: SNAPSHOT_CAP });
  const files: Record<string, SnapshotEntry> = {};
  const blobs = blobDir(folder, runId);
  // A fresh baseline never inherits blobs from an earlier run that reused
  // the id (it cannot, ids are unique), but a crashed capture might have
  // left a partial directory; start clean.
  await rm(blobs, { recursive: true, force: true });
  await mkdir(blobs, { recursive: true });
  let budget = BLOB_BUDGET_BYTES;
  for (const f of walked) {
    if (f.size > MAX_FILE_BYTES) continue;
    let fp;
    try {
      fp = await fingerprint(f);
    } catch {
      continue;
    }
    files[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, hash: fp.hash };
    // Keep a copy of small text files: it is the only way a non-git folder
    // gets a real diff (and a real "deleted" body) later. Content-addressed,
    // so identical files cost one copy.
    if (fp.content && isText(fp.content) && budget >= fp.content.length) {
      const dest = path.join(blobs, fp.hash);
      try {
        await stat(dest);
      } catch {
        await writeFile(dest, fp.content);
        budget -= fp.content.length;
      }
    }
  }
  const out: Baseline = { kind: 'snapshot', at, files };
  if (truncated) out.truncated = true;
  return out;
}

/** The baseline recorded for a run, or null if none was (or it is unreadable). */
export async function loadBaseline(folder: string, runId: string): Promise<Baseline | null> {
  try {
    const raw = JSON.parse(await readFile(baselinePath(folder, runId), 'utf8')) as Baseline;
    if (raw && (raw.kind === 'git' || raw.kind === 'snapshot') && typeof raw.at === 'number') return raw;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Line diff — used when git is not there to do it. Prefix/suffix trimming
// then an LCS table on the middle; past LCS_CELL_CAP the middle is emitted as
// "all old lines removed, all new lines added", which is still a correct
// diff, merely a coarse one.
// ---------------------------------------------------------------------------

type Op = { t: ' ' | '-' | '+'; s: string };

function editScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', s: a[i] });
  for (const op of lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))) ops.push(op);
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: ' ', s: a[i] });
  return ops;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const ops: Op[] = [];
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > LCS_CELL_CAP) {
    for (const s of a) ops.push({ t: '-', s });
    for (const s of b) ops.push({ t: '+', s });
    return ops;
  }
  const w = m + 1;
  // L[i*w+j] = length of the LCS of a[i..] and b[j..]
  const L = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[i] === b[j]
        ? L[(i + 1) * w + j + 1] + 1
        : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { ops.push({ t: '-', s: a[i] }); i++; }
    else { ops.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });
  return ops;
}

/** Unified-diff text (3 lines of context) from an edit script. */
function unified(ops: Op[], oldName: string, newName: string, context = 3): string[] {
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  // Old/new line counts before each op index, for hunk headers.
  const oldBefore = new Int32Array(ops.length + 1);
  const newBefore = new Int32Array(ops.length + 1);
  for (let k = 0; k < ops.length; k++) {
    oldBefore[k + 1] = oldBefore[k] + (ops[k].t === '+' ? 0 : 1);
    newBefore[k + 1] = newBefore[k] + (ops[k].t === '-' ? 0 : 1);
  }
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue; }
    const start = Math.max(0, k - context);
    let last = k;
    let end = k;
    while (end < ops.length) {
      if (ops[end].t !== ' ') last = end;
      else if (end - last > 2 * context) break;
      end++;
    }
    end = Math.min(ops.length, last + context + 1);
    const oldLen = oldBefore[end] - oldBefore[start];
    const newLen = newBefore[end] - newBefore[start];
    const oldStart = oldLen === 0 ? oldBefore[start] : oldBefore[start] + 1;
    const newStart = newLen === 0 ? newBefore[start] : newBefore[start] + 1;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (let x = start; x < end; x++) out.push(ops[x].t + ops[x].s);
    k = end;
  }
  return out;
}

function capLines(lines: string[]): { diff: string; truncated?: boolean } {
  if (lines.length <= DIFF_LINE_CAP) return { diff: lines.join('\n') };
  return { diff: lines.slice(0, DIFF_LINE_CAP).join('\n'), truncated: true };
}

function countOps(ops: Op[]): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const op of ops) {
    if (op.t === '+') additions++;
    else if (op.t === '-') deletions++;
  }
  return { additions, deletions };
}

/** A DeckFile for a file whose whole content is new (untracked, or added since the snapshot). */
async function wholeFileAdded(abs: string, rel: string, preexisting?: boolean): Promise<DeckFile> {
  const file: DeckFile = { path: rel, status: 'added', additions: 0, deletions: 0 };
  if (preexisting) file.preexisting = true;
  let content: Buffer;
  try {
    const st = await stat(abs);
    if (st.size > MAX_FILE_BYTES) return file;
    content = await readFile(abs);
  } catch {
    return file;
  }
  if (!isText(content)) { file.binary = true; return file; }
  const ops = editScript([], splitLines(content.toString('utf8')));
  file.additions = ops.length;
  Object.assign(file, capLines(unified(ops, '/dev/null', `b/${rel}`)));
  return file;
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

/**
 * What changed in `folder` since the run's baseline, plus what it produced.
 * Never throws: git trouble degrades to `baseline.kind = 'none'` with a note,
 * and the artifact list is computed independently.
 */
export async function deckFor(folder: string, runId: string): Promise<Deck> {
  const baseline = await loadBaseline(folder, runId);
  let deck: Deck;
  try {
    if (!baseline) {
      deck = emptyDeck(runId, NO_BASELINE_NOTE);
    } else if (baseline.kind === 'git') {
      deck = await gitDeck(folder, runId, baseline);
    } else {
      deck = await snapshotDeck(folder, runId, baseline);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deck = emptyDeck(runId, `Changes could not be computed (${failureClass(msg)}): ${msg}`);
  }
  try {
    deck.artifacts = await artifactsFor(folder, runId, baseline?.at);
  } catch {
    deck.artifacts = [];
  }
  return deck;
}

function emptyDeck(runId: string, note: string): Deck {
  return {
    runId, baseline: { kind: 'none' }, files: [], artifacts: [],
    totals: { files: 0, additions: 0, deletions: 0 }, note,
  };
}

function failureClass(msg: string): string {
  if (/ENOENT/.test(msg) && /git/.test(msg)) return 'git not installed';
  if (/not a git repository/i.test(msg)) return 'not a git repository';
  if (/^git /.test(msg)) return 'git failed';
  if (/EACCES|EPERM/.test(msg)) return 'permission denied';
  return 'unexpected error';
}

function finish(runId: string, baseline: Deck['baseline'], files: DeckFile[], totalChanged: number, notes: string[]): Deck {
  const totals = { files: totalChanged, additions: 0, deletions: 0 };
  for (const f of files) { totals.additions += f.additions; totals.deletions += f.deletions; }
  if (totalChanged > files.length) {
    notes.push(`Showing ${files.length} of ${totalChanged} changed files.`);
  }
  const deck: Deck = { runId, baseline, files, artifacts: [], totals };
  if (notes.length) deck.note = notes.join(' ');
  return deck;
}

async function gitDeck(folder: string, runId: string, baseline: Extract<Baseline, { kind: 'git' }>): Promise<Deck> {
  const roots = await gitRoots(folder);
  if (!roots) throw new Error('git rev-parse: not a git repository (the folder was one when the run started)');
  const { top } = roots;
  folder = roots.folder;
  const dirty = new Set(baseline.dirty);
  const notes: string[] = [];

  // Tracked changes relative to the baseline commit. Statuses come from
  // `--name-status -z`: `M\0path\0`, `R100\0old\0new\0`, and so on.
  type Change = { status: DeckFile['status']; path: string; from?: string };
  const changes: Change[] = [];
  if (baseline.head) {
    const out = await git(['diff', '--name-status', '-z', '-M', baseline.head, '--', folder], top);
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (!code) continue;
      const letter = code[0];
      if (letter === 'R' || letter === 'C') {
        const from = relToFolder(folder, top, parts[++i] ?? '');
        const to = relToFolder(folder, top, parts[++i] ?? '');
        if (to !== null && !isScratch(to)) changes.push({ status: letter === 'R' ? 'renamed' : 'added', path: to, from: from ?? undefined });
        continue;
      }
      const rel = relToFolder(folder, top, parts[++i] ?? '');
      if (rel === null || isScratch(rel)) continue;
      changes.push({
        status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified',
        path: rel,
      });
    }
  } else {
    // Empty repository at baseline: everything tracked now is new.
    const out = await git(['ls-files', '-z', '--', folder], top);
    for (const p of out.split('\0')) {
      const rel = p ? relToFolder(folder, top, p) : null;
      if (rel !== null && !isScratch(rel)) changes.push({ status: 'added', path: rel });
    }
  }
  const seen = new Set(changes.map((c) => c.path));
  const untracked: string[] = [];
  for (const e of await gitStatus(folder, top)) {
    // The work dir is the mission's scratch: it is listed as artifacts, never
    // as changes, even when the folder has no .foreman/.gitignore yet.
    if (e.xy === '??' && !seen.has(e.path) && !isScratch(e.path)) { untracked.push(e.path); seen.add(e.path); }
  }

  const total = changes.length + untracked.length;
  const files: DeckFile[] = [];
  for (const c of changes) {
    if (files.length >= FILE_CAP) break;
    // With no baseline commit there is nothing for git to diff against; the
    // file's whole content is the change.
    files.push(baseline.head
      ? await gitFile(folder, top, baseline.head, c, dirty.has(c.path))
      : await wholeFileAdded(path.join(folder, c.path), c.path, dirty.has(c.path)));
  }
  for (const rel of untracked) {
    if (files.length >= FILE_CAP) break;
    files.push(await wholeFileAdded(path.join(folder, rel), rel, dirty.has(rel)));
  }
  if (dirty.size) {
    notes.push('Files marked preexisting were already modified before the run started; the diff shown may not all be the run\'s doing.');
  }
  return finish(runId, { kind: 'git', at: baseline.at, head: baseline.head }, files, total, notes);
}

async function gitFile(
  folder: string, top: string, head: string,
  c: { status: DeckFile['status']; path: string; from?: string }, preexisting: boolean,
): Promise<DeckFile> {
  const abs = path.join(folder, c.path);
  // The pathspec must name both sides of a rename or git sees an add and a delete.
  const spec = c.from ? [path.join(folder, c.from), abs] : [abs];
  const file: DeckFile = { path: c.path, status: c.status, additions: 0, deletions: 0 };
  if (preexisting) file.preexisting = true;
  const numstat = (await git(['diff', '--numstat', '-M', head, '--', ...spec], top)).trim().split('\n')[0] ?? '';
  const [add, del] = numstat.split('\t');
  if (add === '-' && del === '-') { file.binary = true; return file; }
  file.additions = Number(add) || 0;
  file.deletions = Number(del) || 0;
  // numstat treats an unreadable/large file as text; sniff the working copy
  // too (a deleted file has none, and git already judged its blob).
  if (c.status !== 'deleted') {
    try {
      const st = await stat(abs);
      if (st.size > MAX_FILE_BYTES) return file;
      const head8k = Buffer.alloc(Math.min(st.size, SNIFF_BYTES));
      if (head8k.length) {
        const fh = await open(abs, 'r');
        try { await fh.read(head8k, 0, head8k.length, 0); } finally { await fh.close(); }
      }
      if (!isText(head8k)) { file.binary = true; return file; }
    } catch { /* fall through to the diff, which is what we would show anyway */ }
  }
  const raw = await git(['diff', '-M', head, '--', ...spec], top);
  Object.assign(file, capLines(splitLines(raw)));
  return file;
}

async function snapshotDeck(folder: string, runId: string, baseline: Extract<Baseline, { kind: 'snapshot' }>): Promise<Deck> {
  const { files: now } = await walk(folder, { skipWork: true, limit: SNAPSHOT_CAP });
  const blobs = blobDir(folder, runId);
  const notes: string[] = [];
  if (baseline.truncated) {
    notes.push(`The baseline stopped at ${SNAPSHOT_CAP} files, so additions beyond that point may be misreported.`);
  }

  type Change = { status: DeckFile['status']; rel: string; abs?: string; size?: number; oldHash?: string };
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const f of now) {
    if (f.size > MAX_FILE_BYTES) continue;
    seen.add(f.rel);
    const before = baseline.files[f.rel];
    // Cheap pre-check: identical size and mtime means we never hashed it.
    if (before && before.size === f.size && before.mtimeMs === f.mtimeMs) continue;
    let hash: string;
    try {
      hash = (await fingerprint(f)).hash;
    } catch {
      continue;
    }
    if (!before) changes.push({ status: 'added', rel: f.rel, abs: f.abs, size: f.size });
    else if (before.hash !== hash) changes.push({ status: 'modified', rel: f.rel, abs: f.abs, size: f.size, oldHash: before.hash });
  }
  for (const rel of Object.keys(baseline.files)) {
    if (!seen.has(rel)) changes.push({ status: 'deleted', rel, oldHash: baseline.files[rel].hash });
  }
  changes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const files: DeckFile[] = [];
  let deletedWithoutBody = 0;
  for (const c of changes) {
    if (files.length >= FILE_CAP) break;
    const old = c.oldHash ? await readFile(path.join(blobs, c.oldHash)).catch(() => null) : null;
    if (c.status === 'added') {
      files.push(await wholeFileAdded(c.abs as string, c.rel));
      continue;
    }
    const file: DeckFile = { path: c.rel, status: c.status, additions: 0, deletions: 0 };
    if (c.status === 'deleted') {
      if (old) {
        const ops = editScript(splitLines(old.toString('utf8')), []);
        file.deletions = ops.length;
        Object.assign(file, capLines(unified(ops, `a/${c.rel}`, '/dev/null')));
      } else {
        deletedWithoutBody++;
      }
      files.push(file);
      continue;
    }
    // modified
    let content: Buffer | null = null;
    try {
      content = await readFile(c.abs as string);
    } catch { /* unreadable now: report the change without a diff */ }
    if (content && !isText(content)) { file.binary = true; files.push(file); continue; }
    if (content && (c.size as number) <= HASH_BYTES && old) {
      const ops = editScript(splitLines(old.toString('utf8')), splitLines(content.toString('utf8')));
      Object.assign(file, countOps(ops));
      Object.assign(file, capLines(unified(ops, `a/${c.rel}`, `b/${c.rel}`)));
    }
    files.push(file);
  }
  if (deletedWithoutBody) {
    notes.push(`${deletedWithoutBody} deleted file(s) had no copy in the baseline (binary or over the size budget), so their line counts are unknown.`);
  }
  return finish(runId, { kind: 'snapshot', at: baseline.at }, files, changes.length, notes);
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

async function artifactsFor(folder: string, runId: string, since: number | undefined): Promise<DeckArtifact[]> {
  const { files } = await walk(folder, { skipWork: false, limit: ARTIFACT_WALK_CAP });
  const baselineJson = toPosix(path.relative(folder, baselinePath(folder, runId)));
  const blobsPrefix = `${toPosix(path.relative(folder, blobDir(folder, runId)))}/`;
  const out: DeckArtifact[] = [];
  for (const f of files) {
    if (f.rel === baselineJson || f.rel.startsWith(blobsPrefix)) continue;
    if (f.rel.startsWith(`${WORK_DIR}/`) && path.basename(f.rel) === '.gitignore') continue;
    const produced = f.rel.startsWith('screenshots/') || f.rel.startsWith(`${WORK_DIR}/`);
    // Anything else counts only if it looks like output and is newer than
    // the baseline; without a baseline there is no "newer", so only the two
    // dedicated locations are listed.
    const recent = since !== undefined && f.mtimeMs > since && ARTIFACT_EXTS.has(ext(f.rel));
    if (produced || recent) out.push({ path: f.rel, kind: artifactKind(f.rel), size: f.size, mtimeMs: f.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
  return out.slice(0, ARTIFACT_CAP);
}

/** Listed files per project tree. */
const TREE_CAP = 2_000;

/**
 * The project's working tree as it stands: every file the deck would consider,
 * minus `.foreman`, which is Foreman's own. No baseline, no diff — this is the
 * view for a project between missions, where "what is in this folder" is the
 * question and every run shares the answer.
 */
export async function projectTree(folder: string): Promise<{ files: DeckArtifact[]; truncated: boolean }> {
  const { files, truncated } = await walk(folder, { skipWork: true, limit: TREE_CAP });
  const out: DeckArtifact[] = [];
  for (const f of files) {
    if (f.rel === '.foreman' || f.rel.startsWith('.foreman/')) continue;
    out.push({ path: f.rel, kind: artifactKind(f.rel), size: f.size, mtimeMs: f.mtimeMs });
  }
  return { files: out, truncated };
}

/**
 * Resolve an artifact path for serving, or null if it is not something the
 * deck may hand out. The jail is the realpath of `folder`: `..`, absolute
 * paths and symlinks that resolve elsewhere all land outside it. Null (never
 * a throw) so the route turns every refusal into a 404.
 */
export async function readArtifact(
  folder: string, relPath: string,
): Promise<{ absPath: string; mime: string; size: number } | null> {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes('\0')) return null;
  const normalized = path.normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.startsWith('../')) return null;
  try {
    const root = await realpath(folder);
    const absPath = await realpath(path.join(root, normalized));
    if (absPath !== root && !absPath.startsWith(root + path.sep)) return null;
    const st = await stat(absPath);
    if (!st.isFile() || st.size > MAX_ARTIFACT_BYTES) return null;
    let mime = MIME[ext(absPath)];
    if (!mime) {
      // Unknown extension: look, don't guess. A file with no NUL in its first
      // 8K is text a person can read in the viewer; anything else downloads.
      const head = Buffer.alloc(SNIFF_BYTES);
      const fh = await open(absPath, 'r');
      let n = 0;
      try { n = (await fh.read(head, 0, SNIFF_BYTES, 0)).bytesRead; } finally { await fh.close(); }
      mime = n > 0 && isText(head.subarray(0, n)) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
    }
    return { absPath, mime, size: st.size };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function pipeFile(absPath: string, res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const stream = createReadStream(absPath);
    stream.on('error', () => { res.destroy(); resolve(); });
    res.on('close', resolve);
    stream.pipe(res);
  });
}

/** Real types, for the preview route only — where the sandbox, not the type, is what keeps a page from running as Foreman. */
const PREVIEW_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * `GET /runs/{id}/deck`, `GET /projects/{id}/tree`, `GET …/artifact?path=<rel>`
 * and `GET …/preview/<rel>` (sandboxed render, see below). Returns
 * true when the URL was one of ours (whatever the outcome), false so the
 * caller's router falls through. `lookup` maps a run id to its folder; null
 * means unknown run, which is a 404 rather than an error.
 */
export async function handleDeckRoute(
  req: IncomingMessage, res: ServerResponse, url: URL,
  lookup: (scope: 'runs' | 'projects', id: string) => Promise<{ folder: string } | null>,
): Promise<boolean> {
  // The same jail and the same viewer serve two scopes: a run (its deck,
  // relative to a baseline) and a project (its tree as it stands, no baseline).
  const m = url.pathname.match(/^\/(runs|projects)\/([^/]+)\/(deck|tree|artifact|preview)(?:\/(.*))?$/);
  if (!m) return false;
  const [, scope, runId, what, previewRel] = m;
  if ((what === 'preview') !== (previewRel !== undefined)) return false;
  if ((what === 'deck' && scope !== 'runs') || (what === 'tree' && scope !== 'projects')) return false;
  try {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!RUN_ID_RE.test(runId)) { sendJson(res, 404, { error: 'not found' }); return true; }
    const run = await lookup(scope as 'runs' | 'projects', runId);
    if (!run) { sendJson(res, 404, { error: 'not found' }); return true; }

    if (what === 'deck') {
      sendJson(res, 200, await deckFor(run.folder, runId));
      return true;
    }
    if (what === 'tree') {
      sendJson(res, 200, await projectTree(run.folder));
      return true;
    }

    if (what === 'preview') {
      // A rendered look at an HTML artifact. Files come out with their real
      // types so the page's own CSS, scripts and JSON resolve by relative
      // path — but every response carries a CSP `sandbox` (no same-origin),
      // so the document runs in an opaque origin whether it is framed by the
      // viewer or opened in a tab: no cookies, no storage, no dashboard DOM.
      // Nothing an agent wrote is ever a same-origin page of Foreman's.
      const art = await readArtifact(run.folder, decodeURIComponent(previewRel));
      if (!art) { sendJson(res, 404, { error: 'not found' }); return true; }
      res.writeHead(200, {
        'content-type': PREVIEW_MIME[ext(art.absPath)] ?? art.mime,
        'content-length': art.size,
        'cache-control': 'no-store',
        'content-security-policy': "sandbox allow-scripts; frame-ancestors 'self'",
        // The sandboxed page has an opaque origin, so its own fetch() of a
        // sibling JSON file is cross-origin. Read-only files, already jailed.
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
      });
      await pipeFile(art.absPath, res);
      return true;
    }

    const rel = url.searchParams.get('path') ?? '';
    const art = await readArtifact(run.folder, rel);
    if (!art) { sendJson(res, 404, { error: 'not found' }); return true; }
    const inline = /^(image\/|text\/|application\/pdf|application\/json)/.test(art.mime);
    const filename = path.basename(art.absPath).replace(/["\r\n]/g, '_');
    res.writeHead(200, {
      'content-type': art.mime,
      'content-length': art.size,
      'cache-control': 'no-store',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      // Belt and braces for the svg/html case: nothing served here may run.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'x-content-type-options': 'nosniff',
    });
    await pipeFile(art.absPath, res);
    return true;
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.destroy();
    return true;
  }
}
