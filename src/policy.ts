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
 *  7. Write/Edit outside the mission folder ALWAYS prompts, whatever the
 *     policy says — grants never bypass the job-site boundary. The same
 *     boundary applies to Bash: a command that would WRITE outside the
 *     folder (`cd /tmp && npm install`, `mkdir -p /tmp/x`, `> ~/.zshrc`)
 *     prompts even under a blanket 'allow'; reads of outside paths
 *     (`cat /etc/hosts`, `which node`) stay silent. Shell cannot be analysed
 *     exactly, so this is the conservative heuristic in `bashEscapesFolder`.
 *  8. Everything else prompts.
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
 */
type ArgMode = 'all' | 'last' | 'opts';
const WRITE_VERBS: Record<string, { mode: ArgMode; opts?: string[]; does: string }> = {
  mkdir:    { mode: 'all',  does: 'creates a path' },
  touch:    { mode: 'all',  does: 'creates a path' },
  rm:       { mode: 'all',  does: 'deletes a path' },
  rmdir:    { mode: 'all',  does: 'deletes a path' },
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
/** Prefixes that merely wrap the real verb (`sudo rm`, `env FOO=1 mkdir`). */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin']);
/** Pseudo-devices: writing to them touches nothing on disk. */
const DEV_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `> f`, `>> f`, `2> f`, `&> f` — but not `2>&1` / `>&2` (fd duplication). */
const REDIRECT_RE = /(?:&>>?|\d*>>?)(?!&)\s*(\S+)/g;

/** Strips one layer of matching quotes and shell grouping punctuation. */
function bare(token: string): string {
  let t = token.replace(/^[(\\]+|[)]+$/g, '');
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
 * Conservative check: would this shell command WRITE outside `folder`?
 * Returns a one-line human-readable reason, or null when nothing in the
 * command looks like an outside write.
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
export function bashEscapesFolder(command: string, folder: string): string | null {
  const root = path.resolve(folder);
  const rootDir = root + path.sep;
  const outside = (p: string): boolean =>
    p !== root && !p.startsWith(rootDir) && !DEV_SINKS.has(p);
  const label = (seg: string): string => (seg.length > 80 ? seg.slice(0, 77) + '…' : seg);

  let cwd = root; // virtual cwd, so `cd sub && rm -rf ../../x` resolves correctly

  const segments = command
    .split(/&&|\|\||;|\n|\|(?!\|)|(?<![&>\d])&(?![&>])/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    // Redirections first — they apply whatever the verb is (`echo x > ~/.zshrc`).
    for (const m of segment.matchAll(REDIRECT_RE)) {
      const p = asPath(m[1], cwd);
      if (p !== null && outside(p)) {
        return `${label(segment)} — redirects output outside the mission folder`;
      }
    }
    const words = segment.replace(REDIRECT_RE, ' ').split(/\s+/).filter(Boolean).map(bare);
    // Peel wrappers and leading VAR=value assignments to reach the real verb.
    let i = 0;
    while (i < words.length && (WRAPPERS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) i++;
    if (i >= words.length) continue;
    const verb = path.basename(words[i]);
    const args = words.slice(i + 1);
    const flagless = args.filter((a) => !a.startsWith('-'));

    if (verb === 'cd' || verb === 'pushd') {
      const target = flagless[0] ?? '~'; // bare `cd` goes home
      const p = asPath(target, cwd) ?? path.resolve(cwd, target);
      cwd = p;
      // Enough on its own: whatever follows (relative writes, `npm install`,
      // `git init`) lands there, so we need not look at later segments.
      if (outside(p)) return `${label(segment)} — writes after this land outside the mission folder`;
      continue;
    }

    // Which arguments are write targets for this verb?
    let targets: string[] = [];
    let does = 'writes to a path';
    const spec = WRITE_VERBS[verb];
    if (spec) {
      does = spec.does;
      if (spec.mode === 'all') targets = args;
      else if (spec.mode === 'last') targets = flagless.slice(-1);
      else {
        for (let k = 0; k < args.length; k++) {
          const opt = spec.opts!.find((o) => args[k] === o || args[k].startsWith(o + '='));
          if (!opt) continue;
          targets.push(args[k].includes('=') ? args[k] : (args[k + 1] ?? ''));
        }
      }
    } else if (verb === 'sed' && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
      does = 'edits a file'; targets = flagless;
    } else if (verb === 'find' && (args.includes('-delete') ||
      args.some((a, k) => /^-(exec|execdir|ok)$/.test(a) && WRITE_VERBS[path.basename(args[k + 1] ?? '')]))) {
      does = 'modifies paths'; targets = flagless;
    } else if (verb === 'git' && /^(clone|init|worktree)$/.test(flagless[0] ?? '')) {
      does = 'creates a repository'; targets = flagless.slice(1);
    } else if (verb === 'dd') {
      does = 'writes to a path'; targets = args.filter((a) => a.startsWith('of='));
    }

    for (const t of targets) {
      const p = asPath(t, cwd);
      if (p !== null && outside(p)) return `${label(segment)} — ${does} outside the mission folder`;
    }
  }
  return null;
}

/** A pending approval routed to the UI; resolved by the human's decision. */
export interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  suggestions?: PermissionUpdate[];
}

export interface PolicyHooks {
  /** Announce a silent allow (for the transcript). `reason` is the SDK's
   *  decision reason when one was present but overridden by a grant. */
  onAutoAllow(agent: string, toolName: string, reason?: string): void;
  /** Present an approval card; the returned promise resolves on decision. */
  onAsk(agent: string, id: string, request: {
    toolName: string;
    input: Record<string, unknown>;
    title?: string;
    description?: string;
    decisionReason?: string;
  }): void;
  /** Register/unregister the pending resolution for HTTP lookup. */
  register(id: string, pending: PendingPermission): void;
  unregister(id: string): boolean;
}

/**
 * Builds the `canUseTool` callback for one agent (director or worker).
 *
 * @param agent      Label shown on cards and transcript entries.
 * @param folder     The mission's working directory (absolute).
 * @param runAllowed Mutable per-run set of tools the human granted "always".
 */
export function makePolicy(
  agent: string,
  folder: string,
  runAllowed: Set<string>,
  hooks: PolicyHooks,
  settings?: { toolPolicy?: ToolPolicy; autoAllowReadOnly?: boolean },
): CanUseTool {
  const foremanDir = path.join(folder, '.foreman') + path.sep;
  const folderDir = path.resolve(folder) + path.sep;
  const toolPolicy = { ...DEFAULT_TOOL_POLICY, ...settings?.toolPolicy };
  const autoReadOnly = settings?.autoAllowReadOnly !== false;

  return async (toolName, input, opts) => {
    // An explicit grant (Settings policy or the human's "Always" click) is a
    // deliberate decision about a TOOL, so a heuristic decisionReason like
    // "contains shell syntax that cannot be statically analyzed" must not
    // override it — that reason fires on loops, expansions and background
    // processes, i.e. on most real work. A matched ask-rule is a configured
    // instruction rather than a heuristic, so it still forces a prompt, as
    // does the folder boundary checked below.
    const routine = !opts.matchedAskRule;
    const filePath = typeof input.file_path === 'string' ? input.file_path : null;
    const isMissionDocWrite =
      (toolName === 'Write' || toolName === 'Edit') &&
      filePath !== null &&
      path.resolve(filePath).startsWith(foremanDir);
    // A file edit outside the job site always prompts, whatever the policy
    // says — blanket grants must not bypass the folder boundary.
    const outsideFolder =
      (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') &&
      filePath !== null &&
      !path.resolve(filePath).startsWith(folderDir);
    // The shell is the other door out of the job site: a command that would
    // write outside the folder prompts under the same rule, so a blanket
    // `Bash: allow` (or an "Always" click) cannot quietly `cd /tmp && npm i`.
    const bashEscape =
      toolName === 'Bash' && typeof input.command === 'string'
        ? bashEscapesFolder(input.command, folder)
        : null;
    const leavesFolder = outsideFolder || bashEscape !== null;

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
      return { behavior: 'allow' };
    }

    const id = opts.toolUseID ?? opts.requestId;
    hooks.onAsk(agent, id, {
      toolName,
      input,
      title: bashEscape !== null ? 'Shell command leaves the mission folder' : opts.title,
      description: bashEscape ?? opts.description,
      decisionReason: opts.decisionReason ??
        (leavesFolder ? `Path is outside the mission folder (${folder})` : undefined),
    });

    return new Promise<PermissionResult>((resolve) => {
      hooks.register(id, { resolve, toolName, suggestions: opts.suggestions });
      opts.signal.addEventListener('abort', () => {
        if (hooks.unregister(id)) {
          resolve({ behavior: 'deny', message: 'Run was interrupted.' });
        }
      });
    });
  };
}
