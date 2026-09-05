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
import {
  armAskTimeout, formatAnswers, normaliseQuestions,
  type AskAnswers, type AskQuestion, type PendingAsk,
} from './ask.js';

/**
 * How long the planner waits on a question before answering itself.
 *
 * Planning is the one attended surface — the human is, by definition, in the
 * chat — so this is long. It is not infinite, because the rule that every
 * ask carries an unattended default has no exceptions: a human who stepped
 * away mid-conversation should come back to a planner that made a reasonable
 * assumption and said so, not to a turn that has been hanging for an hour.
 */
export const PLANNER_ASK_TIMEOUT_MS = 30 * 60_000;

/**
 * Questions the planner is waiting on, one per project at most.
 *
 * Module-level rather than per turn because the answer arrives on a different
 * HTTP request than the one that started the turn. Keyed by project: a
 * planning turn is one `query()` call, one turn runs at a time per project
 * (server.ts enforces it), and a turn can only be parked on one question at a
 * time — so the project id is the natural key and a second question from the
 * same turn replaces the first.
 */
const pendingAsks = new Map<string, PendingAsk & {
  resolve: (answers: AskAnswers | null) => void;
  cancel: () => void;
}>();

/** The question a project's planner is currently parked on, for a client that loads mid-turn. */
export function pendingChatQuestion(projectId: string): PendingAsk | null {
  const p = pendingAsks.get(projectId);
  return p ? { id: p.id, questions: p.questions, askedAt: p.askedAt } : null;
}

/**
 * Deliver the human's answers to a waiting `ask_user`. Returns false when
 * nothing is waiting under that id — a stale card, or a double click — so the
 * route can say so instead of pretending.
 */
export function answerChatQuestion(projectId: string, id: string, answers: AskAnswers): boolean {
  const p = pendingAsks.get(projectId);
  if (!p || p.id !== id) return false;
  p.cancel();
  pendingAsks.delete(projectId);
  p.resolve(answers);
  return true;
}

/** Called when a turn ends for any reason, so a dead turn never holds a question open. */
function dropPendingAsk(projectId: string): void {
  const p = pendingAsks.get(projectId);
  if (!p) return;
  p.cancel();
  pendingAsks.delete(projectId);
  p.resolve(null);
}

/**
 * The only built-in tools the planner gets. Passed as the `tools` base set, so
 * the rest are never even defined for the model — cheaper than defining them
 * and refusing the calls, and it removes the temptation entirely.
 */
const PLANNER_TOOLS = ['Read', 'Grep', 'Glob'];

/** Conversation, not deep reasoning. Overridable from Settings (plannerModel). */
export const DEFAULT_PLANNER_MODEL = 'sonnet';

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
   ASK WITH OPTIONS, NOT PROSE. When a question has a small set of sensible
   answers — stack, scope, source of assets, which of two approaches — call
   mcp__foreman__ask_user with those answers as options. The human clicks
   instead of typing, and you get an unambiguous answer instead of a
   paragraph to interpret. Put the option you would recommend FIRST and say
   why in its hint. Batch up to three related questions in one call. Keep
   prose questions for the genuinely open-ended ("what is this for?"). If no
   answer comes, the tool tells you so: proceed on your recommendation and
   state the assumption in your reply and in any proposal.
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
     - a budget you can justify from the size of the work;
     - browser: true whenever a DONE WHEN criterion needs a page to load,
       render, be free of console errors, or be screenshotted. The card starts
       with the browser on; a mission that needs one and starts without it
       fails its own criteria an hour later.
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
  /** Keys the one question this project's planner may be parked on. */
  projectId: string;
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
  if (
    toolName === 'mcp__foreman__propose_mission'
    || toolName === 'mcp__foreman__ask_user'
    || PLANNER_TOOLS.includes(toolName)
  ) {
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
      browser: z.boolean().optional().describe(
        'True when the mission needs a browser: any DONE WHEN criterion about pages ' +
        'loading, rendering, console errors or screenshots. The card starts with it on.'),
    },
    async ({ mission, done_when, budget_usd, rationale, browser }) => {
      proposal = {
        id: `mp-${Date.now().toString(36)}`,
        mission,
        doneWhen: done_when,
        budgetUsd: budget_usd,
        rationale,
        // The planner knows whether the criteria need a browser better than
        // a default does. A mission whose DONE WHEN says "screenshots saved"
        // once started with the browser off and lost an hour to it.
        browser: browser === true ? true : undefined,
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

  /**
   * A question with options, rendered as a picker in place of the input box.
   *
   * Blocks inside the turn until the human answers or the timeout fires. That
   * is safe here where it would not be in a mission: the POST that started
   * this turn already returned, the SSE stream carries the question, and the
   * one cost of waiting is that the planner cannot start a second turn — which
   * is also true while it is thinking.
   */
  const askUser = tool(
    'ask_user',
    'Ask the human one to three questions that each have a small set of sensible ' +
    'answers. They see clickable options instead of a paragraph to reply to, and ' +
    'you get exact answers back. Put your recommended option first. Not for ' +
    'open-ended questions — ask those in prose.',
    {
      questions: z.array(z.object({
        question: z.string().describe('One clear question'),
        options: z.array(z.union([
          z.string(),
          z.object({
            label: z.string(),
            hint: z.string().optional().describe('One line: what choosing this implies'),
          }),
        ])).min(2).max(6).describe('Sensible answers, recommended first'),
        multi: z.boolean().optional().describe('Allow choosing several'),
      })).min(1).max(3),
    },
    async ({ questions: raw }) => {
      const questions: AskQuestion[] = normaliseQuestions(raw);
      const id = `q-${Date.now().toString(36)}`;
      // A second question from the same turn replaces the first: the model
      // moved on, and a stale card the human answers into nothing is worse
      // than one that quietly disappeared.
      dropPendingAsk(turn.projectId);

      const answers = await new Promise<AskAnswers | null>((resolve) => {
        const timer = armAskTimeout(PLANNER_ASK_TIMEOUT_MS, () => {
          pendingAsks.delete(turn.projectId);
          turn.emit('chat_question_timeout', { id, afterMs: PLANNER_ASK_TIMEOUT_MS });
          resolve(null);
        });
        pendingAsks.set(turn.projectId, {
          id, questions, askedAt: Date.now(), resolve, cancel: () => timer.cancel(),
        });
        turn.emit('chat_question', { id, questions });
      });

      const text = answers
        ? `The human answered:\n${formatAnswers(questions, answers)}`
        : `No answer after ${PLANNER_ASK_TIMEOUT_MS / 60_000} minutes — the human stepped away. ` +
          'Proceed on your recommended options, and state each assumption plainly in your ' +
          'reply and in any proposal so they can correct it when they return.';
      return { content: [{ type: 'text' as const, text }] };
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
        mcpServers: { foreman: createSdkMcpServer({ name: 'foreman', tools: [proposeMission, askUser] }) },
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
    // A turn that ended with a question still open — crash, interrupt, SDK
    // error — must not leave a card the human can answer into nothing.
    dropPendingAsk(turn.projectId);
    // The turn is over: dispose the subprocess rather than leaving one warm
    // per project. Continuity comes from the session id, not from a process.
    await (q as AsyncGenerator<SDKMessage> | undefined)?.return?.(undefined as never)
      .catch(() => {});
  }
}
