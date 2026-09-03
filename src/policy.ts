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
 *  5. Tools the human granted "always allow" for this run are auto-allowed —
 *     but only for routine asks. A rule-forced ask or one carrying a
 *     decisionReason (e.g. a path outside the working directory) always
 *     prompts, so blanket grants never bypass guardrails.
 *  6. Everything else prompts.
 */
import path from 'node:path';
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

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
  /** Announce a silent allow (for the transcript). */
  onAutoAllow(agent: string, toolName: string): void;
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
): CanUseTool {
  const foremanDir = path.join(folder, '.foreman') + path.sep;

  return async (toolName, input, opts) => {
    const routine = !opts.matchedAskRule && !opts.decisionReason;
    const filePath = typeof input.file_path === 'string' ? input.file_path : null;
    const isMissionDocWrite =
      (toolName === 'Write' || toolName === 'Edit') &&
      filePath !== null &&
      path.resolve(filePath).startsWith(foremanDir);

    const browser = browserToolDecision(toolName, input);
    if (
      browser === 'allow' ||
      toolName.startsWith('mcp__foreman__') ||
      AUTO_ALLOW_TOOLS.has(toolName) ||
      isMissionDocWrite ||
      (browser !== 'ask' && runAllowed.has(toolName) && routine)
    ) {
      hooks.onAutoAllow(agent, toolName);
      return { behavior: 'allow' };
    }

    const id = opts.toolUseID ?? opts.requestId;
    hooks.onAsk(agent, id, {
      toolName,
      input,
      title: opts.title,
      description: opts.description,
      decisionReason: opts.decisionReason,
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
