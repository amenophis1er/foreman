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
 *     policy says — grants never bypass the job-site boundary.
 *  8. Everything else prompts.
 */
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
      !outsideFolder && (
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
      title: opts.title,
      description: opts.description,
      decisionReason: opts.decisionReason ??
        (outsideFolder ? `Path is outside the mission folder (${folder})` : undefined),
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
