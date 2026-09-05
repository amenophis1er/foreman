/**
 * Mission titles.
 *
 * A brief is a paragraph of instructions; a run list needs a name. Clipping
 * the brief mid-word ("Design a high-end fitness studio bran…") reads as an
 * accident, so once per run Foreman asks the cheapest model for a short label
 * and persists it in run metadata.
 *
 * Three properties matter more than the title itself:
 *  - It is never load-bearing. The call is fire-and-forget and every failure
 *    path returns null, leaving the UI to fall back to the brief.
 *  - It bills the same provider as the mission it names, so a project pinned to
 *    its own login does not quietly charge someone else a fraction of a cent.
 *  - It costs what it costs, visibly: the caller folds the reported spend into
 *    the run's cost rather than hiding it.
 */
import os from 'node:os';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEnv } from './provider.js';

/** Cheapest model in the roster — the whole point of the exercise. */
const TITLE_MODEL = 'haiku';

/** Titles longer than this are a summary, not a name. */
const MAX_TITLE_CHARS = 60;

/** A stuck subprocess must not leak; the title is optional, so give up early. */
const TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT =
  'You name software missions. You reply with the title and nothing else: no ' +
  'preamble, no quotes, no trailing period, no markdown.';

export interface RunTitle {
  title: string;
  /** What the naming call itself cost, for the run's ledger. */
  costUsd: number;
}

/** Collapses model output into a single short line, or null if unusable. */
function cleanTitle(raw: string): string | null {
  const line = raw.trim().split('\n').find((l) => l.trim()) ?? '';
  const cleaned = line
    .replace(/^["'`*\s]+|["'`*\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 3) return null;
  return cleaned.length > MAX_TITLE_CHARS
    ? cleaned.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…'
    : cleaned;
}

/**
 * Asks the cheap model to name a mission. Resolves to null on any failure —
 * no auth, no network, a timeout, or a model that answered with prose.
 *
 * Runs with no tools, no setting sources, and a temp cwd: this call must not
 * read the project, and giving it nothing to read is cheaper than trusting it
 * not to.
 */
export async function generateRunTitle(
  mission: string,
  agentEnv: AgentEnv,
): Promise<RunTitle | null> {
  const brief = mission.trim().slice(0, 2000);
  if (!brief) return null;

  const prompt =
    'Name this mission in 3-7 words — a title someone can pick out of a list, ' +
    'naming the concrete thing being built or changed. Reply with the title only.\n\n' +
    `MISSION:\n${brief}`;

  let q: ReturnType<typeof query> | undefined;
  const timer = setTimeout(() => {
    void (q as AsyncGenerator<SDKMessage> | undefined)?.return?.(undefined as never)
      .catch(() => {});
  }, TIMEOUT_MS);

  try {
    q = query({
      prompt,
      options: {
        model: TITLE_MODEL,
        maxTurns: 1,
        // Everything below strips context this call has no use for. It is not
        // tidiness: the same request with the default harness context loaded
        // (Claude Code's tools plus the account's claude.ai connectors) costs
        // around 100x more than the ~$0.0003 it costs stripped, because the
        // tool definitions dwarf the paragraph being named.
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
        // A title is a lookup, not a problem: reasoning tokens here cost more
        // than the answer is worth.
        thinking: { type: 'disabled' },
        // A plain string prompt opts out of the claude_code preset; with no
        // setting sources, the user's CLAUDE.md and plugins stay out too.
        systemPrompt: SYSTEM_PROMPT,
        settingSources: [],
        cwd: os.tmpdir(),
        ...agentEnv,
      },
    });

    let text = '';
    let costUsd = 0;
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const m = msg as Record<string, unknown>;
      if (m.type === 'assistant') {
        const content = (m.message as { content?: Array<Record<string, unknown>> })?.content ?? [];
        for (const b of content) if (b.type === 'text') text += String(b.text ?? '');
      } else if (m.type === 'result') {
        if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
        if (m.is_error) return null;
      }
    }

    const title = cleanTitle(text);
    return title ? { title, costUsd } : null;
  } catch {
    return null; // a name is never worth failing a mission over
  } finally {
    clearTimeout(timer);
    await (q as AsyncGenerator<SDKMessage> | undefined)?.return?.(undefined as never)
      .catch(() => {});
  }
}
