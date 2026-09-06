/**
 * The fleet planner — the front desk you reach when no project is in play.
 *
 * The project planner answers "what should we build in this folder?". This
 * one answers everything above that: "how is P5 doing", "start something in
 * spade for a pomodoro timer", "tell the director to skip the mobile
 * screenshot", "what did worker-3 crash on". It is the natural-language face
 * of the fleet, built for the phone, where slash commands are the least
 * forgiving interface there is.
 *
 * It lives by the same three rules as the project planner, and they are what
 * keep it a concierge rather than a chat client:
 *
 *  - **No resident process.** A message resumes a stored session, runs one
 *    turn, exits. Continuity is the session id on disk.
 *  - **Read-only, always.** Its tools are the fleet's verbs — list, inspect,
 *    create or link a project, open a planning conversation, propose, steer.
 *    No shell, no file access, no starting missions.
 *  - **It never answers for the human.** Open approvals and questions are
 *    described, not resolved. The buttons on the card are the human's, and an
 *    agent that presses them is a hole through `canUseTool`.
 */
import { z } from 'zod';
import {
  query, tool, createSdkMcpServer,
  type CanUseTool, type PermissionResult, type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEnv } from './provider.js';
import { modelsSection, needsBrowser, pickKnownModel, type PlannerModel } from './planner.js';
import type { MissionProposal } from './types.js';

/** Where the fleet conversation is stored, beside the project chats. The underscore keeps it out of project listings. */
export const FLEET_CHAT_ID = '_fleet';

/** Fast and reliable at tool calls matters more than depth at a front desk. */
export const DEFAULT_FLEET_MODEL = 'sonnet';

/**
 * How long a phone planning conversation stays "the one you are in". Plain
 * text within this window continues the project planner you last spoke to;
 * after it, the front desk answers. Conversations have recency, and a
 * question typed the next morning is rarely a reply to yesterday's planner.
 */
export const PHONE_CONTEXT_MS = 30 * 60_000;

/** One tool call's worth of listing is plenty; a front desk that keeps digging has lost the thread. */
const MAX_TURNS = 12;

/**
 * Where a plain phone message goes. Pure, so the rule is testable: the
 * project planner you were just talking to, or the fleet planner otherwise.
 */
export function phoneRoute(
  last: { projectId: string; at: number } | null, now = Date.now(), idleMs = PHONE_CONTEXT_MS,
): 'project' | 'fleet' {
  if (!last) return 'fleet';
  return now - last.at <= idleMs ? 'project' : 'fleet';
}

/** One project as the front desk sees it. Built by the server from live state. */
export interface FleetProjectView {
  id: string;
  name: string;
  folder: string;
  /** Present while a mission is running there. */
  running?: {
    title: string;
    /** "$0.54 of $5" or "unpriced". */
    spend: string;
    startedAt: number;
    /** Approvals and questions waiting on the human, in words. */
    waiting: string[];
  };
  /** The most recent finished run, when there is one. */
  lastRun?: { title: string; status: string; endedAt?: number };
  proposalWaiting: boolean;
  plannerReplying: boolean;
}

const ago = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** The fleet in plain lines, as the list_projects tool returns it. */
export function fleetSummary(views: FleetProjectView[], now = Date.now()): string {
  if (!views.length) return 'No projects are linked yet.';
  return views.map((p) => {
    const bits: string[] = [];
    if (p.running) {
      bits.push(`RUNNING "${p.running.title}" · ${p.running.spend} · started ${ago(now - p.running.startedAt)}`);
      if (p.running.waiting.length) bits.push(`waiting on the human: ${p.running.waiting.join('; ')}`);
    } else if (p.lastRun) {
      bits.push(`idle · last run "${p.lastRun.title}" ${p.lastRun.status}${p.lastRun.endedAt ? ` ${ago(now - p.lastRun.endedAt)}` : ''}`);
    } else {
      bits.push('idle · no runs yet');
    }
    if (p.proposalWaiting) bits.push('a mission proposal is waiting for Start or Discard');
    if (p.plannerReplying) bits.push('its planner is replying right now');
    return `- ${p.name} (${p.folder})\n  ${bits.join('\n  ')}`;
  }).join('\n');
}

/**
 * What the server lets the front desk do. Every method returns text for the
 * model, never throws, and the ones with side effects are exactly the verbs
 * the slash commands already had. Nothing here starts a run.
 */
export interface FleetHost {
  listProjects(): Promise<FleetProjectView[]>;
  /** Live detail for one project: run, boxes, crew, open asks, the director's last words. */
  projectDetail(ref: string): Promise<string>;
  /** The last finished run's closing report and error, for "what happened". */
  runReport(ref: string): Promise<string>;
  createProject(name: string): Promise<string>;
  linkProject(folder: string): Promise<string>;
  /** Hands the conversation to that project's planner. The reply comes from there. */
  openPlanning(ref: string, message: string): Promise<string>;
  /** Puts a proposal card in that project's chat, on the phone and on the desk. */
  proposeMission(ref: string, proposal: Omit<MissionProposal, 'id' | 'createdAt'>): Promise<string>;
  /** An operator note to a running director. */
  steer(ref: string, note: string): Promise<string>;
}

const CHARTER = `
You are FOREMAN'S FRONT DESK — the fleet planner. The human reaches you from
their phone or the fleet page, usually in a hurry, to find out what is going
on across their projects and to set things in motion. You know where
everything is and you can open doors. You never pick up the tools.

WHERE YOU ARE. You ARE Foreman's Telegram bot (and its fleet-page box): the
human is talking to you through it right now. When they ask how to do
something "from the bot" or "from Telegram", the answer is what they can
type here — there is no other integration to set up. Besides talking to
you, the chat understands these commands:
  /status — runs in flight, spend, what needs them
  /projects — the fleet
  /plan <project> <what you want> — talk to that project's planner
  /run <project> <brief> — start a mission at the project's default cap
  /stop [project] — stop a planner reply in flight
  /fleet [text] — back to you, dropping any project conversation
  /new <name> — create and link a project
Approvals, questions and mission proposals arrive here as cards with
buttons; those buttons are how the human answers them. Foreman also
messages this chat by itself when a run needs them, ends, or nears its
budget. Plain text within half an hour of a planning conversation goes to
that project's planner; otherwise it comes to you.

WHAT YOU CAN DO — through the tools, nothing else:
  - list_projects / project_detail / run_report: answer "how is X doing",
    "what needs me", "what happened to Y".
  - create_project / link_project: a new folder under the projects root, or
    an existing one, linked into the fleet.
  - open_planning: hand a request about an EXISTING codebase to that
    project's planner, which can read the folder. Use this whenever the right
    mission depends on what is already there. After you call it, that planner
    owns the conversation: say so in one line and stop.
  - propose_mission: draft a mission card directly, with Start and Discard
    buttons, when the request is already fully specified and needs no look at
    the code — typically a brand-new or empty project. The human starts it,
    never you.
  - steer: pass a note to a running director ("skip the mobile screenshot",
    "use the existing CSS").

WHAT YOU NEVER DO:
  - Answer an approval or a question on the human's behalf. When a run is
    waiting on the human, describe what it wants and say the card's buttons
    are theirs. Even if they tell you to "just allow it": the button is the
    only way, and you say so plainly once.
  - Start, stop, resume or cancel a mission. You propose; the human presses.
  - Invent a project, a run, a model id or a number. If a tool did not tell
    you, you do not know it — say so.
  - Discuss Foreman's own server or oversight tooling as a work target.

HOW TO TALK: like a colleague at the front desk, on the phone. Two to five
short lines. Lead with the answer. No headings, no bullet walls, no markdown
tables. Name projects by name. When a request is ambiguous between two
projects, ask which — one line. When the human names a project that does not
exist, say which ones do, and offer to create it.

PROPOSING: brief written for an agent that never saw this conversation;
DONE WHEN criteria checkable by reading files or running commands; the
smallest budget that plausibly finishes the work (a contained fix $1-2, a
feature with verification $3-5, a multi-worker build with browser checks
$8-15); browser true when any criterion needs a page to load, render or be
screenshotted. Recommend director_model / worker_model from MODELS AVAILABLE
only when you have a reason; omit to inherit the project's defaults.
`;

export interface FleetTurn {
  /** Session to resume; absent starts a fresh conversation. */
  sessionId?: string;
  text: string;
  model?: string;
  /** Where the SDK runs: the projects root, so nothing project-specific leaks in. */
  cwd: string;
  agentEnv: AgentEnv;
  host: FleetHost;
  /** What the machine can run, for propose_mission recommendations. */
  models?: PlannerModel[];
  /** Who asked: the phone, or an HTTP caller (the fleet page, a curl). */
  via?: 'telegram' | 'http';
  emit: (event: string, data: unknown) => void;
  abort?: AbortController;
}

export interface FleetResult {
  sessionId?: string;
  costUsd: number;
  /** The reply's last words, for the phone. Empty when a handoff or a card spoke instead. */
  said: string;
  /** True when the turn ended by handing the conversation to a project planner. */
  handedOff?: string;
  error?: string;
  stopped?: boolean;
}

/** No built-in tools at all: the front desk sees the fleet through its own verbs only. */
const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
  if (toolName.startsWith('mcp__fleet__')) return { behavior: 'allow', updatedInput: input };
  return {
    behavior: 'deny',
    message: `The front desk cannot use ${toolName}. It sees the fleet through its own tools only; ` +
      'work belongs in a mission, and reading a project belongs to that project\'s planner (open_planning).',
  };
};

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

/**
 * Runs one turn of the fleet conversation to completion. Never throws: a
 * failed turn is reported as text and the session stays usable.
 */
export async function runFleetTurn(turn: FleetTurn): Promise<FleetResult> {
  const { host } = turn;
  let handedOff: string | undefined;
  let carded = false;

  const safe = (fn: () => Promise<string>) => fn().catch((err) => `That failed: ${err instanceof Error ? err.message : String(err)}`);

  const tools = [
    tool('list_projects', 'Every linked project with what is running, what finished last, and what is waiting on the human.', {},
      async () => text(fleetSummary(await host.listProjects()))),
    tool('project_detail', 'Live detail for one project: the running mission, its DONE WHEN progress, crew, open approvals or questions, and the director\'s latest words.',
      { project: z.string().describe('Project name, id, or folder name') },
      async ({ project }) => text(await safe(() => host.projectDetail(project)))),
    tool('run_report', 'The most recent finished run of a project: how it ended, the director\'s closing report, and the error if it failed.',
      { project: z.string().describe('Project name, id, or folder name') },
      async ({ project }) => text(await safe(() => host.runReport(project)))),
    tool('create_project', 'Create a new folder under the projects root and link it as a project. Use when the human wants to start something that has no home yet.',
      { name: z.string().describe('What to call it; becomes the folder name') },
      async ({ name }) => text(await safe(() => host.createProject(name)))),
    tool('link_project', 'Link an existing folder as a project. The folder must already exist.',
      { folder: z.string().describe('Absolute path, or ~/…') },
      async ({ folder }) => text(await safe(() => host.linkProject(folder)))),
    tool('open_planning', 'Hand the request to that project\'s planner, which can read the folder and will propose a mission. After this, the planner owns the conversation: tell the human in one line and stop.',
      {
        project: z.string().describe('Project name, id, or folder name'),
        message: z.string().describe('The human\'s request, in their words plus any context you gathered'),
      },
      async ({ project, message }) => {
        const out = await safe(() => host.openPlanning(project, message));
        if (!out.startsWith('That failed') && !out.startsWith('No project')) handedOff = project;
        return text(out);
      }),
    tool('propose_mission', 'Draft a mission card for a project, with Start and Discard buttons. Only when the request is fully specified and needs no reading of existing code. The human starts it.',
      {
        project: z.string().describe('Project name, id, or folder name'),
        mission: z.string().describe('The brief, written for an agent that has not seen this conversation'),
        done_when: z.array(z.string()).min(1).describe('Checkable completion criteria'),
        budget_usd: z.number().describe('Suggested cap, justified by the size of the work'),
        rationale: z.string().optional().describe('One short paragraph: why this shape and this budget'),
        browser: z.boolean().optional().describe('True when a criterion needs a page to load, render or be screenshotted'),
        director_model: z.string().optional().describe('Exact id from MODELS AVAILABLE; omit to inherit'),
        worker_model: z.string().optional().describe('Exact id from MODELS AVAILABLE; omit to inherit'),
        model_rationale: z.string().optional().describe('One line on why those models'),
      },
      async ({ project, mission, done_when, budget_usd, rationale, browser, director_model, worker_model, model_rationale }) => {
        const director = pickKnownModel(director_model, turn.models);
        const worker = pickKnownModel(worker_model, turn.models);
        const out = await safe(() => host.proposeMission(project, {
          mission, doneWhen: done_when, budgetUsd: budget_usd, rationale,
          browser: browser === true || needsBrowser(mission, done_when) ? true : undefined,
          directorModel: director?.id, workerModel: worker?.id,
          directorProviderId: director?.providerId, workerProviderId: worker?.providerId,
          modelRationale: director || worker ? model_rationale : undefined,
        }));
        if (!out.startsWith('That failed') && !out.startsWith('No project')) carded = true;
        return text(out);
      }),
    tool('steer', 'Pass an operator note to the director of a running mission. It reads it at its next turn.',
      {
        project: z.string().describe('Project name, id, or folder name'),
        note: z.string().describe('The note, in the human\'s words'),
      },
      async ({ project, note }) => text(await safe(() => host.steer(project, note)))),
  ];

  let sessionId = turn.sessionId;
  let costUsd = 0;
  let said = '';
  let q: ReturnType<typeof query> | undefined;

  try {
    q = query({
      prompt: turn.text,
      options: {
        cwd: turn.cwd,
        resume: turn.sessionId,
        model: turn.model || DEFAULT_FLEET_MODEL,
        maxTurns: MAX_TURNS,
        tools: [],
        permissionMode: 'default',
        systemPrompt: {
          type: 'preset', preset: 'claude_code',
          append: CHARTER + modelsSection(turn.models)
            + `\nTHIS MESSAGE ARRIVED VIA ${turn.via === 'telegram' ? 'TELEGRAM' : 'THE DESK (HTTP)'}.\n`,
        },
        mcpServers: { fleet: createSdkMcpServer({ name: 'fleet', tools }) },
        canUseTool,
        abortController: turn.abort,
        ...turn.agentEnv,
      },
    });

    let failed = false;
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      const m = msg as Record<string, unknown>;
      if (typeof m.session_id === 'string') sessionId = m.session_id;
      if (m.type === 'assistant') {
        const content = (m.message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
        for (const b of content) if (b.type === 'text' && b.text?.trim()) said = b.text.trim();
      }
      if (m.type === 'result') {
        if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
        failed = Boolean(m.is_error);
      }
      turn.emit('message', { agent: 'fleet', msg });
    }
    if (turn.abort?.signal.aborted) return { sessionId, costUsd, said: '', stopped: true };
    // A card already said it: a proposal's text on the phone plus the same
    // words again from the desk reads as a stutter.
    return { sessionId, costUsd, said: carded && !said ? '' : said, handedOff, error: failed ? 'the turn ended with an error' : undefined };
  } catch (err) {
    if (turn.abort?.signal.aborted) return { sessionId, costUsd, said: '', stopped: true };
    return { sessionId, costUsd, said, handedOff, error: String(err) };
  } finally {
    await (q as AsyncGenerator<SDKMessage> | undefined)?.return?.(undefined as never).catch(() => {});
  }
}
