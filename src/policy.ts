/**
 * Permission policy — decides which tool calls run silently and which are
 * routed to the human as approval cards.
 *
 * Rules, in order:
 *  1. Foreman's own MCP tools (spawn_worker, …) are always allowed — they are
 *     the director's control surface, already governed by charter + budget.
 *  2. A fixed allowlist of read-only/reversible tools is auto-allowed.
 *  3. Writes/edits inside the mission's `.foreman/` directory are auto-allowed
 *     (the mission doc is Foreman bookkeeping, not user code).
 *  4. Playwright browser tools (headless, isolated profile) are auto-allowed
 *     EXCEPT navigation to non-local URLs, which prompts — the browser can
 *     freely exercise the app under test but going out to the internet is a
 *     human decision.
 *  5. Tools granted by the human — "always allow" for this run, or an
 *     'allow' in the Settings tool policy — are auto-allowed. A matched
 *     ask-rule still forces a prompt; the SDK's heuristic decisionReason
 *     does not, since it fires on ordinary shell work (loops, expansions,
 *     background processes) and the real guardrails are enforced below.
 *  6. The per-run tool policy (Settings, snapshotted at run start) applies:
 *     'allow' runs silently, 'deny' blocks with guidance, 'ask' prompts.
 *     Defaults are autonomy-first (Bash/Write/Edit/WebFetch allowed).
 *  7. A write into a TEMP directory (/tmp, $TMPDIR, os.tmpdir()) is denied
 *     outright with a redirect to `WORK_DIR` — never asked. See
 *     `tempDirDenial` for why this is the one outside location whose right
 *     answer is always known in advance.
 *  8. Write/Edit outside the mission folder ALWAYS prompts, whatever the
 *     policy says — grants never bypass the job-site boundary. The same
 *     boundary applies to Bash: a command that would WRITE outside the
 *     folder (`cd /tmp && npm install`, `mkdir -p /tmp/x`, `> ~/.zshrc`)
 *     prompts even under a blanket 'allow'; reads of outside paths
 *     (`cat /etc/hosts`, `which node`) stay silent. Shell cannot be analysed
 *     exactly, so this is the conservative heuristic in `bashEscapesFolder`.
 *     The one way past the boundary is a PATH grant, not a tool grant: the
 *     human approves "always" on an escape card and the caller adds that
 *     card's `escapedPath` to `allowedRoots`, after which paths under it
 *     count as inside. "Always allow Bash" alone never opens the filesystem.
 *  9. Everything else prompts.
 */
import os from 'node:os';
import path from 'node:path';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ToolPolicy } from './types.js';

/**
 * Autonomy-first defaults: a mission runs hands-off inside its folder.
 * Users tighten these per project (or globally) in Settings.
 */
export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  Bash: 'allow', Write: 'allow', Edit: 'allow', WebFetch: 'allow',
};

/**
 * The sanctioned scratch space inside a mission folder, relative to it.
 *
 * A director that wants a verification script, a screenshot, a helper's
 * node_modules or some temp output has a correct instinct — keep the project
 * root clean — and, before this existed, no in-workspace place to act on it.
 * So it reached for /tmp. This directory is the habit's outlet: inside the
 * folder (so no prompt, no stall), gitignored (so the root stays clean), and
 * named by path in both charters and in every denial (so the model has a
 * place, not a principle). The orchestrator creates it at every run start so
 * "it does not exist yet" is never the reason to go elsewhere.
 *
 * Defined here rather than in the orchestrator because the policy's temp-dir
 * denial names it and the orchestrator imports the policy — one constant, no
 * import cycle. The orchestrator re-exports it for its callers.
 */
export const WORK_DIR = '.foreman/work';

export const AUTO_ALLOW_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'TodoWrite', 'Task',
  'WebFetch', 'WebSearch', 'NotebookRead', 'ListMcpResources',
]);

/** Hostnames the headless browser may navigate to without asking. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * Decides whether a Playwright tool call is silently allowed. Everything is
 * (clicks, typing, screenshots act on the already-open page) except
 * navigation to a non-local URL.
 */
export function browserToolDecision(
  toolName: string, input: Record<string, unknown>,
): 'allow' | 'ask' | null {
  if (!toolName.startsWith('mcp__playwright__')) return null;
  if (toolName === 'mcp__playwright__browser_navigate') {
    const url = typeof input.url === 'string' ? input.url : '';
    try {
      const host = new URL(url).hostname;
      return LOCAL_HOSTS.has(host) ? 'allow' : 'ask';
    } catch {
      return 'ask'; // unparseable target: a human should look at it
    }
  }
  return 'allow';
}

// ---------------------------------------------------------------------------
// Bash folder-boundary heuristic
// ---------------------------------------------------------------------------

/**
 * Verbs that create, delete or modify filesystem entries, mapped to how their
 * path arguments are found. Anything not listed here is treated as read-only
 * (`cat`, `ls`, `grep`, `node`, `curl` without `-o`, …) and never escapes on
 * its own — a read of an outside path is exactly what we want to keep silent.
 *
 *  'all'    every path-like argument is a write target (`mkdir a b`, `rm -rf x`)
 *  'last'   only the final argument is (`cp SRC DST`, `mv`, `ln`, `install`);
 *           reading an outside SRC into the folder is legitimate
 *  'opts'   only the value of a directory/output option is (`npm --prefix`,
 *           `tar -C`, `unzip -d`, `curl -o`); positional args are packages,
 *           URLs or archive members, not write targets
 *
 * `dirs` marks verbs whose targets ARE directories (or whole subtrees), so the
 * path itself is the natural grant root — see `BashEscape.grant`. Verbs left
 * unmarked write files, whose parent directory is the grant.
 */
type ArgMode = 'all' | 'last' | 'opts';
const WRITE_VERBS: Record<string, { mode: ArgMode; opts?: string[]; does: string; dirs?: boolean }> = {
  mkdir:    { mode: 'all',  does: 'creates a path', dirs: true },
  touch:    { mode: 'all',  does: 'creates a path' },
  // rm's target is the whole thing being removed; granting its PARENT after a
  // `rm -rf /opt/homebrew` would be far wider than what the human approved.
  rm:       { mode: 'all',  does: 'deletes a path', dirs: true },
  rmdir:    { mode: 'all',  does: 'deletes a path', dirs: true },
  chmod:    { mode: 'all',  does: 'changes a path' },
  chown:    { mode: 'all',  does: 'changes a path' },
  truncate: { mode: 'all',  does: 'writes to a path' },
  tee:      { mode: 'all',  does: 'writes to a path' },
  mv:       { mode: 'last', does: 'moves into a path' },
  cp:       { mode: 'last', does: 'copies into a path' },
  ln:       { mode: 'last', does: 'links into a path' },
  install:  { mode: 'last', does: 'installs into a path' },
  rsync:    { mode: 'last', does: 'syncs into a path' },
  npm:      { mode: 'opts', opts: ['--prefix', '-C', '--cwd', '--global-dir'], does: 'installs into a path' },
  pnpm:     { mode: 'opts', opts: ['--prefix', '-C', '--dir', '--cwd'], does: 'installs into a path' },
  yarn:     { mode: 'opts', opts: ['--cwd', '--modules-folder'], does: 'installs into a path' },
  pip:      { mode: 'opts', opts: ['--prefix', '--target', '-t', '--root'], does: 'installs into a path' },
  pip3:     { mode: 'opts', opts: ['--prefix', '--target', '-t', '--root'], does: 'installs into a path' },
  unzip:    { mode: 'opts', opts: ['-d'], does: 'extracts into a path' },
  tar:      { mode: 'opts', opts: ['-C', '--directory'], does: 'extracts into a path' },
  curl:     { mode: 'opts', opts: ['-o', '--output', '--output-dir'], does: 'downloads into a path' },
  wget:     { mode: 'opts', opts: ['-O', '-P', '--output-document', '--directory-prefix'], does: 'downloads into a path' },
};
/**
 * Among the 'opts' options above, the ones whose value is a FILE rather than
 * a directory (`curl -o f`, `wget -O f`). Every other option in the table
 * (`--prefix`, `-C`, `-d`, `-P`, `--target`, …) names a directory.
 */
const FILE_OPTS = new Set(['-o', '--output', '-O', '--output-document']);
/** Prefixes that merely wrap the real verb (`sudo rm`, `env FOO=1 mkdir`). */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin']);
/** Shells whose `-c` argument is a command in its own right. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
/** Pseudo-devices: writing to them touches nothing on disk. */
const DEV_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `> f`, `>> f`, `2> f`, `&> f` — but not `2>&1` / `>&2` (fd duplication). */
const REDIRECT_RE = /(?:&>>?|\d*>>?)(?!&)\s*(\S+)/g;

/**
 * Shell operators inside quotes are text, not operators. The redirect scan
 * and the segment split below work on the raw string, so a perl program in
 * single quotes — `perl -pi -e 's/x =>/y/' f` — read as `>` followed by the
 * path `/y/`, which resolved to the filesystem root and put an approval card
 * in front of an ordinary in-folder edit. Operators inside a quoted region
 * are swapped for private-use characters before the scan and swapped back by
 * `bare()`, so tokens still carry their real text. Spaces inside quotes are
 * masked too, so a quoted string is one token: `sh -c '…'` bodies and paths
 * with spaces both come through whole. Quoting rules followed:
 * single quotes take everything literally; double quotes honour backslash;
 * a backslash outside quotes escapes the next character.
 */
const MASK: Record<string, string> = { '>': '\uE001', '<': '\uE002', '|': '\uE003', ';': '\uE004', '&': '\uE005', '\n': '\uE006', ' ': '\uE007', '\t': '\uE008' };
const UNMASK_RE = /[\uE001-\uE008]/g;
const UNMASK: Record<string, string> = Object.fromEntries(Object.entries(MASK).map(([k, v]) => [v, k]));
function maskQuoted(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === null) {
      if (c === '\\' && i + 1 < command.length) { out += c + command[++i]; continue; }
      if (c === '"' || c === "'") quote = c;
      out += c;
      continue;
    }
    if (quote === '"' && c === '\\' && i + 1 < command.length) { out += c + command[++i]; continue; }
    if (c === quote) { quote = null; out += c; continue; }
    out += MASK[c] ?? c;
  }
  return out;
}
const unmask = (s: string): string => s.replace(UNMASK_RE, (ch) => UNMASK[ch] ?? ch);

/** Strips one layer of matching quotes and shell grouping punctuation. */
function bare(token: string): string {
  let t = unmask(token).replace(/^[(\\]+|[)]+$/g, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t;
}

/**
 * Turns a token into an absolute path when it looks like one — absolute,
 * `~`, `$HOME`, or dot-relative (`./x`, `../x`) resolved against the virtual
 * cwd. Plain words (`build`, `-p`, `playwright`) return null: they are
 * flags, package names or paths relative to a cwd we already account for by
 * tracking `cd`. URLs are never paths even though they contain slashes.
 */
function asPath(token: string, cwd: string): string | null {
  let t = bare(token);
  // `--prefix=/tmp/x`, `of=/tmp/img`: the value is what matters.
  const eq = t.indexOf('=');
  if (eq > 0 && !t.startsWith('/')) t = t.slice(eq + 1);
  if (URL_RE.test(t)) return null;
  const home = os.homedir();
  if (t === '~' || t.startsWith('~/')) return path.resolve(home + t.slice(1));
  const m = /^\$\{?HOME\}?(\/.*)?$/.exec(t);
  if (m) return path.resolve(home + (m[1] ?? ''));
  if (t.startsWith('/')) return path.resolve(t);
  if (t === '.' || t === '..' || t.startsWith('./') || t.startsWith('../')) return path.resolve(cwd, t);
  return null;
}

/**
 * True when `p` is one of `roots` or lies beneath one. Trailing-separator
 * prefix comparison, so `/Users/x/proj-backup` is NOT under `/Users/x/proj`.
 * Roots are resolved here so callers can hand over raw strings (the human's
 * grants arrive as whatever the card showed).
 */
export function underAnyRoot(p: string, roots: Iterable<string>): boolean {
  for (const r of roots) {
    const root = path.resolve(r);
    if (p === root || p.startsWith(root + path.sep)) return true;
  }
  return false;
}

/** What `bashEscape` found: the reason for the card plus the path behind it. */
export interface BashEscape {
  /** One-line human-readable reason, e.g. `cd /tmp — writes after this land outside the mission folder`. */
  reason: string;
  /** The resolved outside path that triggered the escape (`/tmp/x/y` for `mkdir -p /tmp/x/y`). */
  path: string;
  /**
   * The DIRECTORY a human would grant to stop being asked about this command
   * and the siblings that follow it. When `path` is itself a directory target
   * (`cd X`, `mkdir X`, `tar -C X`, `npm --prefix X`, `git clone … X`) it is
   * `path`; when it is a file (`> X/out.txt`, `touch X/a`, `sed -i X/f`,
   * `curl -o X/f`) it is `dirname(path)`. Granting the bare file would make
   * the very next `touch X/b` prompt again, which is exactly the loop this
   * exists to break; granting the directory covers the work the human just
   * looked at without widening to its parent.
   */
  grant: string;
}

/**
 * Conservative check: would this shell command WRITE outside `folder` (and
 * outside every directory in `extraRoots`, the human's per-run path grants)?
 * Returns the reason plus the offending path, or null when nothing in the
 * command looks like an outside write. `bashEscapesFolder` is the same check
 * reduced to the reason string.
 *
 * Shell is not statically analysable, so this deliberately errs towards
 * prompting: the cost of a false positive is one approval card, the cost of
 * a false negative is 25 packages in /tmp. What it does:
 *
 *  - Splits on `&&`, `||`, `;`, `|`, `&` and newlines and walks the segments
 *    in order with a virtual cwd that starts at `folder`. `cd`/`pushd` move
 *    it, so `cd sub && mkdir ../x` resolves correctly; a `cd` that lands
 *    outside (`cd /tmp`, `cd ..`, bare `cd`) escapes by itself, because every
 *    later relative write and cwd-writer (`npm install`, `git init`) would
 *    land there — no need to inspect what follows.
 *  - Redirections (`>`, `>>`, `2>`, `&>`) and `tee` targeting an outside path
 *    escape. `/dev/null` & co. do not.
 *  - Write verbs (`WRITE_VERBS`) escape when their write-target argument —
 *    per-verb: all args, only the destination, or only a directory option —
 *    resolves outside. `find` escapes only with `-delete` or `-exec <write
 *    verb>`; `sed` only with `-i`; `git` only for `clone`/`init`/`worktree`
 *    with an outside path; `dd` only for `of=`.
 *  - Everything else is read-only by construction: `cat /etc/hosts`,
 *    `ls ~/.foreman`, `/opt/homebrew/bin/node script.js`, `find / -name x`
 *    return null. System locations (/usr, /opt, /etc, …) need no special
 *    casing — they are only flagged when a write verb targets them directly
 *    (`rm -rf /opt/homebrew` DOES prompt).
 *
 * Known blind spots (all resolve to "not flagged", i.e. the old behaviour):
 * paths built from variables or command substitution (`rm -rf "$DIR"`,
 * `cd $(mktemp -d)`), `eval`, scripts invoked by name (`./setup.sh` may do
 * anything), `xargs`, interpreters given inline code (`node -e`, `python
 * -c`), `cd -`, paths with spaces (the tokenizer splits on whitespace),
 * `git -C <outside> commit`, and any tool not in `WRITE_VERBS`.
 */
export function bashEscape(
  command: string, folder: string, extraRoots: Iterable<string> = [],
  shell?: { cwd?: string },
): BashEscape | null {
  const root = path.resolve(folder);
  // Snapshot the grants once per call: the caller's set is mutable and may be
  // appended to while we walk, and one command must see one consistent view.
  const roots = [root, ...extraRoots];
  const outside = (p: string): boolean => !DEV_SINKS.has(p) && !underAnyRoot(p, roots);
  const label = (raw: string): string => { const seg = unmask(raw); return seg.length > 80 ? seg.slice(0, 77) + '…' : seg; };
  const hit = (segment: string, does: string, p: string, isDir: boolean): BashEscape => ({
    reason: `${label(segment)} — ${does} outside the mission folder`,
    path: p,
    grant: isDir ? p : path.dirname(p),
  });

  // The virtual cwd, so `cd sub && rm -rf ../../x` resolves correctly. It
  // starts where the agent's shell actually is: Claude Code's Bash tool keeps
  // its working directory between commands, so a director that ran
  // `cd examples/demo` one call ago and now writes `../../.foreman/work/x.log`
  // is writing inside the folder — read from the root that looked like two
  // levels out, and put an approval card in front of an in-folder log.
  let cwd = shell?.cwd ? path.resolve(shell.cwd) : root;
  // `cd` inside a subshell does not outlive it; only top-level moves persist.
  let depth = 0;

  const segments = maskQuoted(command)
    .split(/&&|\|\||;|\n|\|(?!\|)|(?<![&>\d])&(?![&>])/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    // Redirections first — they apply whatever the verb is (`echo x > ~/.zshrc`).
    for (const m of segment.matchAll(REDIRECT_RE)) {
      const p = asPath(m[1], cwd);
      if (p !== null && outside(p)) return hit(segment, 'redirects output', p, false);
    }
    const opens = (segment.match(/\(/g) ?? []).length;
    const closes = (segment.match(/\)/g) ?? []).length;
    const words = segment.replace(REDIRECT_RE, ' ').split(/\s+/).filter(Boolean).map(bare);
    // Depth as seen at this segment's verb: an opening paren on the segment
    // itself puts its `cd` inside the subshell.
    const depthHere = depth + (segment.trimStart().startsWith('(') ? 1 : 0);
    depth = Math.max(0, depth + opens - closes);
    // Peel wrappers and leading VAR=value assignments to reach the real verb.
    let i = 0;
    while (i < words.length && (WRAPPERS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
    if (i >= words.length) continue;
    const verb = path.basename(words[i]);
    const args = words.slice(i + 1);
    const flagless = args.filter((a) => !a.startsWith('-'));

    // `sh -c '…'`: the quoted body is a command of its own, run from the
    // current virtual cwd. Analysed as one, so quoting cannot hide a `cd /tmp`
    // — masking made the body opaque to the split above, and this is where it
    // is looked at instead.
    if (SHELLS.has(verb)) {
      const c = args.indexOf('-c');
      if (c >= 0 && c + 1 < args.length) {
        const inner = bashEscape(args[c + 1], cwd, roots);
        if (inner) return { ...inner, reason: `${label(segment)} — ${inner.reason.replace(/^.*? — /, '')}` };
      }
      continue;
    }

    if (verb === 'cd' || verb === 'pushd') {
      const target = flagless[0] ?? '~'; // bare `cd` goes home
      const p = asPath(target, cwd) ?? path.resolve(cwd, target);
      cwd = p;
      // Enough on its own: whatever follows (relative writes, `npm install`,
      // `git init`) lands there, so we need not look at later segments.
      if (outside(p)) return hit(segment, 'writes after this land', p, true);
      if (depthHere === 0 && shell) shell.cwd = p;
      continue;
    }

    // Which arguments are write targets for this verb, and is each a
    // directory (grant it as-is) or a file (grant its parent)?
    let targets: Array<{ tok: string; dir: boolean }> = [];
    let does = 'writes to a path';
    const spec = WRITE_VERBS[verb];
    if (spec) {
      does = spec.does;
      if (spec.mode === 'all') targets = args.map((tok) => ({ tok, dir: spec.dirs === true }));
      // A destination is a directory only when spelled as one (`cp a /tmp/x/`);
      // otherwise assume a file, so the grant is its parent — the human is
      // about to be asked about more copies into the same place.
      else if (spec.mode === 'last') targets = flagless.slice(-1).map((tok) => ({ tok, dir: tok.endsWith('/') }));
      else {
        for (let k = 0; k < args.length; k++) {
          const opt = spec.opts!.find((o) => args[k] === o || args[k].startsWith(o + '='));
          if (!opt) continue;
          targets.push({ tok: args[k].includes('=') ? args[k] : (args[k + 1] ?? ''), dir: !FILE_OPTS.has(opt) });
        }
      }
    } else if (verb === 'sed' && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
      does = 'edits a file'; targets = flagless.map((tok) => ({ tok, dir: false }));
    } else if (verb === 'find' && (args.includes('-delete') ||
      args.some((a, k) => /^-(exec|execdir|ok)$/.test(a) && WRITE_VERBS[path.basename(args[k + 1] ?? '')]))) {
      does = 'modifies paths'; targets = flagless.map((tok) => ({ tok, dir: true })); // find's start path is a tree
    } else if (verb === 'git' && /^(clone|init|worktree)$/.test(flagless[0] ?? '')) {
      does = 'creates a repository'; targets = flagless.slice(1).map((tok) => ({ tok, dir: true }));
    } else if (verb === 'dd') {
      does = 'writes to a path'; targets = args.filter((a) => a.startsWith('of=')).map((tok) => ({ tok, dir: false }));
    }

    for (const t of targets) {
      const p = asPath(t.tok, cwd);
      if (p !== null && outside(p)) return hit(segment, does, p, t.dir);
    }
  }
  return null;
}

/**
 * `bashEscape` reduced to its reason string — the original shape, kept so
 * existing callers and tests read unchanged. `extraRoots` are directories the
 * human has already granted for this run (see `escapedPath`).
 */
export function bashEscapesFolder(
  command: string, folder: string, extraRoots?: Iterable<string>,
): string | null {
  return bashEscape(command, folder, extraRoots)?.reason ?? null;
}

// ---------------------------------------------------------------------------
// Temp directories: deny with a redirect, never ask
// ---------------------------------------------------------------------------

/**
 * The temp directories a write is refused into without a card.
 *
 * `/tmp`, `/private/tmp`, `$TMPDIR` and `os.tmpdir()` — the places a model
 * reaches for when it wants scratch space and has not been told where scratch
 * goes. On macOS `/tmp` and `/var` are symlinks into `/private`, and a command
 * may spell either form (`cd /tmp/x`, `Write /private/tmp/x/f`); the policy
 * resolves paths lexically, not through the filesystem, so both spellings of
 * every root are listed rather than trusting realpath on a path that may not
 * exist yet. Computed once: the environment does not change under a run.
 */
export function tempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = ['/tmp', '/private/tmp', env.TMPDIR, os.tmpdir()].filter((r): r is string => Boolean(r));
  const out = new Set<string>();
  for (const r of raw) {
    const p = path.resolve(r);
    out.add(p);
    if (p.startsWith('/private/')) out.add(p.slice('/private'.length));
    else out.add('/private' + p);
  }
  return [...out];
}
const TEMP_ROOTS = tempRoots();

/** True when `p` is a temp directory or lies under one — see `tempRoots`. */
export function isTempPath(p: string): boolean {
  return underAnyRoot(path.resolve(p), TEMP_ROOTS);
}

/**
 * The message a temp-dir write is denied with. Names the outside path, the
 * in-workspace place to redo it, and why that place exists — the deny is only
 * useful if the model's next attempt lands inside, so the redirect is the
 * substance and the refusal is the packaging.
 */
export function tempDirDenial(p: string, folder: string): string {
  return `Denied: ${p} is outside the mission folder. Scratch work belongs under ` +
    `${folder}/${WORK_DIR}/ — it is gitignored and keeps the project root clean without ` +
    'leaving the project. Redo this there.';
}

/**
 * The sentence every escape card ends with, so the meaning of the "Always"
 * button is stated where the human reads it — it grants THIS PATH, not the
 * tool. Exported for the UI/tests to match on rather than retype.
 */
export const ESCAPE_GRANT_HINT =
  'Approve "always" to allow this path for the rest of the run; other paths outside the folder will still ask.';

/** A pending approval routed to the UI; resolved by the human's decision. */
export interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  suggestions?: PermissionUpdate[];
  /**
   * Present only when the ask was raised by the folder boundary (an outside
   * Write/Edit, or a Bash command `bashEscape` flagged). It is the absolute
   * DIRECTORY to grant — for a file tool, `dirname(file_path)`; for Bash,
   * `BashEscape.grant` (the target itself when it is a directory, its parent
   * when it is a file), chosen so the grant covers the sibling commands the
   * human is about to be asked about, not just the one path on this card.
   *
   * CONTRACT with the orchestrator: on an `allow_always` decision for a
   * pending permission that HAS `escapedPath`, add `escapedPath` to the run's
   * `allowedRoots` set INSTEAD OF adding `toolName` to `runAllowed`. The human
   * clicked "always" on a card about a path, so that is what they granted;
   * a tool grant would be ignored by the boundary check anyway (by design —
   * "always allow Bash" must not open the filesystem) and the next sibling
   * command would prompt again, which is the loop this field breaks. When
   * `escapedPath` is absent, `allow_always` keeps its old meaning (tool grant).
   */
  escapedPath?: string;
}

export interface PolicyHooks {
  /** Announce a silent allow (for the transcript). `reason` is the SDK's
   *  decision reason when one was present but overridden by a grant. */
  onAutoAllow(agent: string, toolName: string, reason?: string): void;
  /**
   * Announce a silent deny (for the transcript) — today only the temp-dir
   * redirect. Optional so existing callers and tests keep their shape; a
   * caller that does not listen still gets the deny, just not the line.
   */
  onAutoDeny?(agent: string, toolName: string, reason: string): void;
  /** Present an approval card; the returned promise resolves on decision. */
  onAsk(agent: string, id: string, request: {
    toolName: string;
    input: Record<string, unknown>;
    title?: string;
    description?: string;
    decisionReason?: string;
    /** Same value as `PendingPermission.escapedPath`, so the card can show what "always" will grant. */
    escapedPath?: string;
  }): void;
  /** Register/unregister the pending resolution for HTTP lookup. */
  register(id: string, pending: PendingPermission): void;
  unregister(id: string): boolean;
}

/**
 * Builds the `canUseTool` callback for one agent (director or worker).
 *
 * @param agent        Label shown on cards and transcript entries.
 * @param folder       The mission's working directory (absolute).
 * @param runAllowed   Mutable per-run set of tools the human granted "always".
 *                     Never consulted for a path that leaves the folder.
 * @param allowedRoots Mutable per-run set of absolute directories the human
 *                     granted "always" on an escape card (see
 *                     `PendingPermission.escapedPath`). Paths under any of
 *                     them count as inside the folder for both file tools and
 *                     Bash. Owned by the caller, like `runAllowed`; read on
 *                     every call so a grant takes effect on the next command.
 */
export function makePolicy(
  agent: string,
  folder: string,
  runAllowed: Set<string>,
  allowedRoots: Set<string>,
  hooks: PolicyHooks,
  settings?: { toolPolicy?: ToolPolicy; autoAllowReadOnly?: boolean },
): CanUseTool {
  const foremanDir = path.join(folder, '.foreman') + path.sep;
  const toolPolicy = { ...DEFAULT_TOOL_POLICY, ...settings?.toolPolicy };
  const autoReadOnly = settings?.autoAllowReadOnly !== false;
  // Where this agent's shell is. One policy per agent session, and the SDK's
  // Bash keeps its cwd across calls, so a top-level `cd` in an allowed
  // command is where the next command starts. Reset only with the session.
  const shell: { cwd?: string } = { cwd: folder };

  return async (toolName, input, opts) => {
    // An explicit grant (Settings policy or the human's "Always" click) is a
    // deliberate decision about a TOOL, so a heuristic decisionReason like
    // "contains shell syntax that cannot be statically analyzed" must not
    // override it — that reason fires on loops, expansions and background
    // processes, i.e. on most real work. A matched ask-rule is a configured
    // instruction rather than a heuristic, so it still forces a prompt, as
    // does the folder boundary checked below.
    const routine = !opts.matchedAskRule;
    const filePath = typeof input.file_path === 'string' ? path.resolve(input.file_path) : null;
    const isMissionDocWrite =
      (toolName === 'Write' || toolName === 'Edit') &&
      filePath !== null &&
      filePath.startsWith(foremanDir);
    // A file edit outside the job site always prompts, whatever the TOOL
    // policy says — blanket grants must not bypass the folder boundary. Only
    // a PATH grant (`allowedRoots`) widens it, and only for that subtree.
    const outsideFolder =
      (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') &&
      filePath !== null &&
      !underAnyRoot(filePath, [folder, ...allowedRoots]);
    // The shell is the other door out of the job site: a command that would
    // write outside the folder prompts under the same rule, so a blanket
    // `Bash: allow` (or an "Always" click) cannot quietly `cd /tmp && npm i`.
    // Analysed from the shell's current directory; the walk records where a
    // top-level `cd` leaves it. A command that escapes is not run unless the
    // human allows it, so its `cd` is remembered only after an allow below.
    const shellAfter = { cwd: shell.cwd };
    const escape =
      toolName === 'Bash' && typeof input.command === 'string'
        ? bashEscape(input.command, folder, allowedRoots, shellAfter)
        : null;
    const rememberCwd = () => { if (toolName === 'Bash') shell.cwd = shellAfter.cwd; };
    const leavesFolder = outsideFolder || escape !== null;
    // What "always" on this card grants — see `PendingPermission.escapedPath`.
    // For a file tool the parent directory: the worker that wrote
    // `/tmp/x/a.ts` is about to write `/tmp/x/b.ts`, and a grant of the
    // single file would re-prompt on it.
    const escapedPath = escape?.grant ?? (outsideFolder ? path.dirname(filePath!) : undefined);

    const granted = toolPolicy[toolName] === 'allow' || runAllowed.has(toolName);

    if (toolPolicy[toolName] === 'deny') {
      return {
        behavior: 'deny',
        message: `${toolName} is denied by this project's tool policy. ` +
          'Escalate via mcp__foreman__ask_human if the mission cannot proceed without it.',
      };
    }

    const browser = browserToolDecision(toolName, input);
    if (
      !leavesFolder && (
        browser === 'allow' ||
        toolName.startsWith('mcp__foreman__') ||
        (autoReadOnly && AUTO_ALLOW_TOOLS.has(toolName)) ||
        isMissionDocWrite ||
        (granted && routine && browser !== 'ask')
      )
    ) {
      // Carry the reason through so the log shows what was waved past.
      hooks.onAutoAllow(agent, toolName, opts.decisionReason);
      rememberCwd();
      return { behavior: 'allow' };
    }

    // A write into a temp directory is the one outside location whose right
    // answer is always known in advance: the model wanted scratch space, and
    // scratch space exists inside the folder at WORK_DIR. Asking is therefore
    // pure cost — a planned mission once sat most of an hour on a /tmp write
    // waiting for a human to say what this line says in a millisecond, and
    // would have died on it had the human been asleep. So it is denied with
    // the redirect and never reaches a card. Everything ELSE outside the
    // folder (a sibling repo, a deploy dir, ~/.config) might be legitimate
    // and stays a human call below — with allowed roots so one "always"
    // covers the siblings, and the orchestrator's unattended timeout so an
    // unanswered card does not hold the run open indefinitely.
    const outsidePath = escape?.path ?? (outsideFolder ? filePath : null);
    if (
      leavesFolder && outsidePath !== null && isTempPath(outsidePath) &&
      (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit')
    ) {
      const message = tempDirDenial(outsidePath, folder);
      hooks.onAutoDeny?.(agent, toolName, message);
      return { behavior: 'deny', message };
    }

    const id = opts.toolUseID ?? opts.requestId;
    // On an escape card the description names the path "always" will grant
    // and ends with `ESCAPE_GRANT_HINT`, because the button's label alone
    // ("Always (run)") reads as a tool grant — which it is not, here.
    let title = opts.title;
    let description = opts.description;
    if (escape !== null) {
      title = 'Shell command leaves the mission folder';
      description = `${escape.reason}. Path: ${escapedPath}. ${ESCAPE_GRANT_HINT}`;
    } else if (outsideFolder) {
      title = 'File edit leaves the mission folder';
      description = `${filePath} is outside the mission folder. Path: ${escapedPath}. ${ESCAPE_GRANT_HINT}`;
    }
    hooks.onAsk(agent, id, {
      toolName,
      input,
      title,
      description,
      // The card's one warning line. When the folder boundary is the reason,
      // say that — the SDK's own heuristic ("contains shell syntax (&) that
      // cannot be statically analyzed") is true of most real commands and
      // tells the reader nothing about why THIS one stopped.
      decisionReason: leavesFolder
        ? (escape?.reason ?? `${filePath} is outside the mission folder`)
        : opts.decisionReason,
      escapedPath,
    });

    return new Promise<PermissionResult>((resolve) => {
      hooks.register(id, {
        resolve: (r) => { if (r.behavior === 'allow') rememberCwd(); resolve(r); },
        toolName, suggestions: opts.suggestions, escapedPath,
      });
      opts.signal.addEventListener('abort', () => {
        if (hooks.unregister(id)) {
          resolve({ behavior: 'deny', message: 'Run was interrupted.' });
        }
      });
    });
  };
}
