/**
 * The planning session — the conversation that happens before a mission.
 *
 * Foreman's director is excellent at executing a well-specified mission and
 * helpless against a vague one, and the brief is where nearly all run quality
 * is decided. Yet the composer demanded that brief at the moment the human
 * knew least. The planner exists to fix that ordering: you talk first, it
 * reads the folder and asks questions, and the conversation's *output* is a
 * mission proposal you can start.
 *
 * Three properties define it, and each is load-bearing:
 *
 *  - **No resident process.** Each turn resumes the stored session, answers,
 *    and exits. An idle conversation costs nothing but disk, and there is
 *    never any ambiguity about whether Foreman is working or waiting — a
 *    question a warm always-on agent could not answer.
 *  - **Read-only, always.** The planner can read the project and nothing else:
 *    no Write, no Edit, no Bash. That is what makes it safe to leave sitting
 *    there, and it is the line that keeps Foreman from quietly becoming a
 *    worse Claude Code. Work is what missions are for.
 *  - **The handoff is an artifact.** `propose_mission` produces a card the
 *    human reads, edits and starts. The moment of commitment stays exactly
 *    where it is today — visible, budgeted, deliberate.
 */
import { z } from 'zod';
import {
  query, tool, createSdkMcpServer,
  type CanUseTool, type PermissionResult, type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEnv } from './provider.js';
import type { MissionProposal } from './types.js';

/**
 * The only built-in tools the planner gets. Passed as the `tools` base set, so
 * the rest are never even defined for the model — cheaper than defining them
 * and refusing the calls, and it removes the temptation entirely.
 */
const PLANNER_TOOLS = ['Read', 'Grep', 'Glob'];

/** Conversation, not deep reasoning. Overridable from Settings later. */
const DEFAULT_PLANNER_MODEL = 'sonnet';

/** A planning turn that reads half the repo has misunderstood its job. */
const MAX_TURNS = 20;

const PLANNER_CHARTER = `
You are the FOREMAN PLANNER. You are the foreman in the site office: the human
comes to you to think out loud about what they want done in this folder, and
your job is to turn that into a mission the crew can execute.

You are NOT doing the work. You cannot write, edit, or run anything — you can
only read the project. When work needs doing, you propose a mission and the
human starts it; a director and its workers then execute it autonomously.

How to behave:

1. TALK LIKE A COLLEAGUE, NOT A FORM. Short, direct answers. Ask about what is
   genuinely ambiguous and would change the work; do not interrogate the human
   through a checklist. One or two good questions beat six obvious ones.
2. LOOK BEFORE YOU ASK. Read the folder first — README, package manifests, the
   files under discussion, CLAUDE.md if present. Never ask a human something
   the repository already answers. Ground what you say in what you actually
   read, and say which files you looked at when it matters.
3. SAY WHAT YOU THINK. If the idea has a problem — the wrong approach, a
   hidden dependency, a much simpler path, something already half-built in the
   repo — say so plainly before it becomes a mission. This conversation is the
   cheapest possible place to change direction.
4. PROPOSE WHEN THE SHAPE IS CLEAR, NOT BEFORE. When you and the human agree
   on what is being built and how you would both know it worked, call
   mcp__foreman__propose_mission. A proposal needs:
     - a mission brief written for an agent that has never seen this
       conversation: full context, paths, constraints, and what to leave alone;
     - DONE WHEN criteria that are actually checkable by reading files or
       running commands, not "works well";
     - a budget you can justify from the size of the work.
   Do not propose on the first message unless the human's request is already
   completely unambiguous. Do not propose the same thing twice; refine it.
   BUDGET, ANCHORED: one small file or a contained fix, $1-2. A feature across
   a few files with real verification, $3-5. A multi-worker build, or anything
   needing browser checks and screenshots, $8-15. The cap is a stop, not a
   target: pick the smallest figure that plausibly finishes the work, and say
   in one line what drove it. Never reach for a round default because it is
   the obvious number.
5. THE HUMAN DECIDES. A proposal is a draft, not a launch. Say what you
   proposed and let them read it. If they want changes, propose again.
6. NEVER discuss Foreman's own server or oversight tooling as a work target.
`;

export interface PlanningTurn {
  /** Session to resume; absent starts a fresh conversation. */
  sessionId?: string;
  folder: string;
  text: string;
  model?: string;
  /** Credential + wire, resolved by the caller. See provider.ts. */
  agentEnv: AgentEnv;
  /** Broadcasts and persists, exactly like a run's emitter. */
  emit: (event: string, data: unknown) => void;
}

export interface PlanningResult {
  /** Session id to store, so the next message continues this conversation. */
  sessionId?: string;
  /** What this turn cost. */
  costUsd: number;
  /** Set when the planner proposed a mission during the turn. */
  proposal?: MissionProposal;
  /** Present when the turn failed; the conversation is still usable. */
  error?: string;
}

/**
 * The planner may read the project and propose a mission. Everything else is
 * denied with an explanation rather than silently failing, so the model
 * redirects to a proposal instead of retrying a tool it will never get.
 */
const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
  if (toolName === 'mcp__foreman__propose_mission' || PLANNER_TOOLS.includes(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }
  return {
    behavior: 'deny',
    message:
      `The planner is read-only and cannot use ${toolName}. You can Read, Grep and Glob ` +
      'to understand the project. If this needs doing, put it in a mission with ' +
      'mcp__foreman__propose_mission and let the human start it.',
  };
};

/**
 * Runs one turn of the conversation to completion.
 *
 * Never throws: a planning turn that fails leaves the conversation intact and
 * reports the failure as text, because losing a design discussion to a
 * transient SDK error would be a far worse outcome than an apology in the
 * transcript.
 */
export async function runPlanningTurn(turn: PlanningTurn): Promise<PlanningResult> {
  let proposal: MissionProposal | undefined;

  const proposeMission = tool(
    'propose_mission',
    'Propose a mission for the human to review and start. Shows them an editable ' +
    'card with the brief, the DONE WHEN criteria and the budget. Call this only ' +
    'once you and the human agree on what is being built.',
    {
      mission: z.string().describe(
        'The brief, written for an agent that has not seen this conversation: ' +
        'full context, paths, constraints, and what to leave alone'),
      done_when: z.array(z.string()).describe(
        'Completion criteria that can actually be checked by reading files or running commands'),
      budget_usd: z.number().describe('Suggested cap in US dollars, justified by the size of the work'),
      rationale: z.string().optional().describe('One short paragraph: why this shape and this budget'),
    },
    async ({ mission, done_when, budget_usd, rationale }) => {
      proposal = {
        id: `mp-${Date.now().toString(36)}`,
        mission,
        doneWhen: done_when,
        budgetUsd: budget_usd,
        rationale,
        createdAt: Date.now(),
      };
      turn.emit('mission_proposed', proposal);
      return {
        content: [{
          type: 'text' as const,
          text: 'Proposal shown to the human. Tell them briefly what you proposed and ' +
            'wait — they start it, or ask you to change it. Do not propose again unless asked.',
        }],
      };
    },
  );

  let sessionId = turn.sessionId;
  let costUsd = 0;
  let q: ReturnType<typeof query> | undefined;

  try {
    q = query({
      prompt: turn.text,
      options: {
        cwd: turn.folder,
        resume: turn.sessionId,
        model: turn.model || DEFAULT_PLANNER_MODEL,
        maxTurns: MAX_TURNS,
        tools: PLANNER_TOOLS,
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: PLANNER_CHARTER },
        mcpServers: { foreman: createSdkMcpServer({ name: 'foreman', tools: [proposeMission] }) },
        canUseTool,
        ...turn.agentEnv,
      },
    });

    let failed = false;
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const m = msg as Record<string, unknown>;
      if (typeof m.session_id === 'string') sessionId = m.session_id;
      if (m.type === 'result') {
        // Cumulative across the turn, and a turn is one query() call, so the
        // reported total is this turn's cost outright — no delta to track.
        if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
        failed = Boolean(m.is_error);
      }
      turn.emit('message', { agent: 'foreman', msg });
    }
    return { sessionId, costUsd, proposal, error: failed ? 'the turn ended with an error' : undefined };
  } catch (err) {
    return { sessionId, costUsd, proposal, error: String(err) };
  } finally {
    // The turn is over: dispose the subprocess rather than leaving one warm
    // per project. Continuity comes from the session id, not from a process.
    await (q as AsyncGenerator<SDKMessage> | undefined)?.return?.(undefined as never)
      .catch(() => {});
  }
}
