/**
 * Linking a project that is not on this machine yet: a Git URL becomes a
 * folder under the projects root, then the folder is linked like any other.
 *
 * Foreman runs `git clone` as the user — their SSH keys, credential helper
 * and `gh auth` all apply, and Foreman never sees, asks for or stores a
 * token. Prompts are disabled so a private repository with no credentials
 * fails in seconds with git's own message instead of hanging on a password
 * question nobody can see.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface RepoRef {
  /** The URL git will be given, normalised. */
  url: string;
  /** Folder name under the projects root: the repository's name. */
  name: string;
  host: string;
}

/**
 * Accepts the forms people paste: `https://github.com/o/r`, with or without
 * `.git` or a trailing slash, `git@github.com:o/r.git`, `ssh://git@host/o/r`,
 * and the shorthand `owner/repo`, which means GitHub. Anything else is null.
 */
export function parseRepoUrl(input: string): RepoRef | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  let m = /^(?:https?:\/\/)([^/\s]+)\/(.+?)(?:\.git)?\/?$/i.exec(s);
  if (m) {
    const host = m[1].toLowerCase();
    const segs = m[2].split('/').filter(Boolean);
    if (segs.length < 2) return null;
    // A web URL to a page inside the repo (tree/…, blob/…) still names the repo.
    const repo = segs.slice(0, 2).join('/');
    return { url: `https://${host}/${repo}.git`, name: safeName(segs[1]), host };
  }
  m = /^git@([^:\s]+):(.+?)(?:\.git)?\/?$/i.exec(s);
  if (m) {
    const segs = m[2].split('/').filter(Boolean);
    if (segs.length < 1) return null;
    return { url: s.endsWith('.git') ? s : `${s.replace(/\/$/, '')}.git`, name: safeName(segs[segs.length - 1]), host: m[1].toLowerCase() };
  }
  m = /^ssh:\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(s);
  if (m) {
    const segs = m[2].split('/').filter(Boolean);
    if (segs.length < 1) return null;
    return { url: s, name: safeName(segs[segs.length - 1]), host: m[1].toLowerCase() };
  }
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s);
  if (m && !s.startsWith('.') && !s.startsWith('/')) {
    return { url: `https://github.com/${m[1]}/${m[2]}.git`, name: safeName(m[2]), host: 'github.com' };
  }
  return null;
}

/** Does this look like a repository rather than a folder path? Cheap gate for the shared "link" verbs. */
export function looksLikeRepoUrl(input: string): boolean {
  const s = input.trim();
  return /^(https?:\/\/|git@|ssh:\/\/)/i.test(s) || (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) && !s.startsWith('.') && !s.startsWith('~'));
}

function safeName(raw: string): string {
  return raw.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'repo';
}

/** Git's stderr, reduced to the one line a person needs. */
export function explainGitFailure(stderr: string, ref: RepoRef): string {
  const t = stderr.trim();
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|could not read Password/i.test(t)) {
    return `Git could not authenticate to ${ref.host}. For a private repository, set up a credential helper or gh auth, or use the SSH URL with a key this machine has.`;
  }
  if (/Repository not found|not found|does not exist/i.test(t)) return `Git says the repository was not found at ${ref.url}. Check the URL — or it is private and this machine cannot see it.`;
  if (/Could not resolve host|unable to access/i.test(t)) return `Could not reach ${ref.host}: ${t.split('\n').pop() ?? t}`;
  if (/Remote branch .* not found/i.test(t)) return t.split('\n').find((l) => /Remote branch/.test(l)) ?? t;
  const last = t.split('\n').filter((l) => l.trim() && !/^Cloning into/.test(l)).pop();
  return last ? `git clone failed: ${last.replace(/^fatal:\s*/i, '')}` : 'git clone failed.';
}

export interface CloneOptions {
  ref: RepoRef;
  dest: string;
  branch?: string;
  /** Git's progress lines ("Receiving objects: 42%"), as they arrive. */
  onProgress?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * `git clone --progress [-b branch] url dest`, as the user. Resolves to null
 * on success or to one explanatory sentence on failure. Never throws.
 */
export function cloneRepo(opts: CloneOptions): Promise<string | null> {
  const { ref, dest, branch, onProgress, timeoutMs = 15 * 60_000 } = opts;
  if (branch && !/^[A-Za-z0-9._\/-]{1,200}$/.test(branch)) return Promise.resolve('That branch name is not one git accepts.');
  const args = ['clone', '--progress', ...(branch ? ['--branch', branch] : []), '--', ref.url, dest];
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn('git', args, {
        cwd: path.dirname(dest),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      return done(`Could not start git: ${err instanceof Error ? err.message : String(err)}`);
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(`git clone took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`); }, timeoutMs);
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      // Progress arrives as carriage-return-separated updates on one line.
      for (const piece of text.split(/[\r\n]+/)) {
        const line = piece.trim();
        if (line && /(objects|deltas|Cloning|Updating|Checking)/i.test(line)) onProgress?.(line);
      }
    });
    child.on('error', (err) => { clearTimeout(timer); done(`Could not run git: ${err.message}. Is git installed?`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? null : explainGitFailure(stderr, ref));
    });
  });
}
