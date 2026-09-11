/**
 * Foreman HTTP server — thin wiring between the browser UI, mission
 * orchestrators, and the run store. No business logic lives here.
 *
 * Concurrency model: a 'shared' project may have at most ONE active mission,
 * because its missions work in its own checkout; a 'worktree' project may have
 * several, each in a worktree of its own under FOREMAN_HOME (see
 * src/isolation.ts). Missions across projects run concurrently. Every live SSE
 * frame is wrapped
 * in an envelope `{runId, projectId, data}` so the UI can route it; persisted
 * event logs keep the bare `{ts, event, data}` shape (the run is implicit in
 * the file's location).
 *
 * Endpoints:
 *   GET    /                     React app (ui/dist; build hint when missing)
 *   GET    /favicon.svg          Brand mark from ui/public
 *   GET    /events               SSE stream (enveloped ForemanEvents)
 *   GET    /settings             Persisted UI settings (global + project overlays)
 *   PUT    /settings             Save settings {global, projectId?, project?}
 *   GET    /models               Curated model list for the composer pickers
 *   GET    /projects             Projects + active-run summaries + pending counts + lastRun
 *   POST   /projects             Link a folder {folder, name?}
 *   DELETE /projects/{id}        Unlink (history kept; active run blocks it)
 *   POST   /run                  Start a mission {projectId, mission, budgetUsd,
 *                                directorModel?, workerModel?, browserTools?}
 *   PATCH  /run                  Change a live run's browser tools or budget
 *   POST   /runs/{id}/resume     Resume an interrupted/failed run
 *   POST   /runs/{id}/worktree/remove  Remove a finished mission's worktree {force?} (409 while live, or on unmerged work)
 *   POST   /permission           Resolve an approval {id, behavior, message?}
 *   POST   /answer               Answer a director question {id, text}
 *   POST   /projects/clone        Clone a Git URL under the projects root and link it {url, branch?} → {id}; GET /projects/clone/{id} polls
 *   GET    /projects/{id}/memory  The project's memory (.foreman/MEMORY.md): text, updatedAt
 *   GET    /projects/{id}/tree    The project's files as they stand (read-only, jailed); …/artifact and …/preview as for runs
 *   GET    /doctor                The same checks `foreman doctor` runs, for the first-run card
 *   GET    /search?q=            Runs across the fleet matching title, brief, project or folder
 *   POST   /fleet/chat           One turn with the fleet planner {text} → {text, costUsd}
 *   POST   /fleet/stop           Stop the fleet planner reply in flight
 *   DELETE /fleet/chat           Forget the fleet conversation
 *   GET    /runs/{id}/pr         The pull request Foreman would draft for a finished run on its own branch
 *   POST   /runs/{id}/pr         Push that branch and open the PR (gh) or hand back the compare URL {title, body}
 *   GET    /runs/{id}/pr/state   open | merged | closed, from gh; a final answer is remembered on the run
 *   POST   /steer                Send an operator note to a running director {runId, text}
 *   POST   /interrupt            Interrupt a run {runId}
 *   GET    /runs?projectId=      Persisted run summaries, newest first
 *   GET    /runs/{id}/events     Full event log for replay
 *   GET    /missiondoc?run=      A run's .foreman/MISSION.md
 *   GET    /browse?path=         Directory listing for the folder picker
 *   POST   /mkdir                Create a subfolder {parent, name}
 *   GET    /locate?name=         Find folders by name under $HOME (drag-drop)
 *   GET    /chat?projectId=      A project's planning conversation (log + meta)
 *   POST   /chat                 Send a message to the planner {projectId, text}
 *   POST   /attachments          Save files into <folder>/.foreman/attachments {projectId, files:[{name,data}]}
 *   POST   /chat/stop            Stop the planner's reply in flight {projectId}
 *   DELETE /chat?projectId=      Forget the conversation and its session
 *   PUT    /providers/{id}/key   Store a provider's key {key}
 *   DELETE /providers/{id}/key   Forget it
 *   GET    /projects/{id}/schedules  This project's schedules + this month's scheduled spend and its ceiling
 *   POST   /projects/{id}/schedules  Add one {name, brief, cadence, budgetUsd, …} → {schedule}
 *   PUT    /schedules/{id}       Change one (same fields, all optional) → {schedule}
 *   DELETE /schedules/{id}       Forget one
 *   POST   /schedules/{id}/pause   Stop it firing until a human resumes it
 *   POST   /schedules/{id}/resume  Start it firing again, from now
 *   POST   /schedules/{id}/run-now Start its mission at once (409 if the project is busy)
 *   GET    /schedules/preview?cadence=  The next three firings of a cadence {next:[ms]}
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionRun } from './orchestrator.js';
import {
  DEFAULT_PLANNER_MODEL, answerChatQuestion, pendingChatQuestion, runPlanningTurn,
  forkSeed,
  dropPendingAsk,
} from './planner.js';
import { DEFAULT_TOOL_POLICY } from './policy.js';
import { pathPermitted, requestAllowed } from './guard.js';
import { BodyError, bodyLimitFor, parseBody } from './http-body.js';
import { saveAttachments } from './attachments.js';
import { cloneRepo, looksLikeRepoUrl, parseRepoUrl } from './clone.js';
import { readMemory } from './memory.js';
import { budgetAnchor, modelRecords, projectRecord, recordLine } from './track-record.js';
import { reconcileRole } from './role-provider.js';
import { detectBrowser, installChromium } from './browser.js';
import { frozenDeck, frozenMissionDoc, parkMissionDoc, restoreMissionDoc, snapshotRun } from './snapshot.js';
import { addMissionWorktree, closeMissionBranch, compareUrl, createPullRequest, dirtyPaths, ensureMissionBranch, ghReady, gitInfo, removeMissionWorktree, resolvePrBase, worktreeBranchMerged, worktreeGrant, worktreeParent, missionBranchName, prDraft, pullRequestState, pushBranch, renameMissionBranch, startMissionBranch, type GitInfo } from './gitwork.js';
import { crewPresetsFrom, type CrewPreset } from './crew.js';
import { frozenCrewFor, reviewReportLines, reviewedByNames } from './run-crew.js';
import { detectTailscale, tailnetUrl } from './tailscale.js';
import { checkForUpdate, currentVersion, type UpdateInfo } from './update.js';
import { ServiceRegistry, listeningPid, portOpen, servicesHandler, stopService } from './services.js';
import { HELP_TEXT, expandHome, parseCommand, projectsRoot, slug } from './notify/commands.js';
import {
  DEFAULT_FLEET_MODEL, FLEET_CHAT_ID, PHONE_CONTEXT_MS, phoneRoute, runFleetTurn,
  type FleetHost, type FleetProjectView, type FleetScheduleView,
} from './fleet-planner.js';
import { escapeHtml as escTg } from './notify.js';
import { RunStore, newRunId } from './store.js';
import {
  concurrencyLimit, isolationAllowed, isolationChoice, repoClaim, reservationDecision,
  resumeWorktree, worktreePath, worktreeRemoval, type Isolation,
} from './isolation.js';
import { preflight, reportPreflight } from './preflight.js';
import { defaultInstance, discoverInstances, effectiveConfigDir } from './instance.js';
import {
  normalizeOpenAiBaseUrl, providerEnv, providerOf, providerProblem, resolveProvider, roleCost,
  withRoleModel,
} from './provider.js';
import { ensureGateway, gatewayStatus, gatewayUsage, releaseGateways, stopGateways } from './gateway.js';
import { discoverOllama, ollamaHost, ollamaProvider } from './ollama.js';
import { deleteSecret, getSecret, hasSecret, putSecret } from './secrets.js';
import { NotifyHub } from './notify.js';
import { handleDeckRoute } from './deck.js';
import { TelegramBot, getMe, linkCode, telegramStartLink, telegramTransport, setBotCommands } from './notify/telegram.js';
import QRCode from 'qrcode';
import { ANTHROPIC_MODELS } from './anthropic-models.js';
import { codexHome, codexModels, readCodexAuth } from './codex.js';
import { costRank, describeModel, discoverModels } from './models.js';
import { isOpenAiHost, openaiPrice, openaiPriceNote } from './openai-prices.js';
import type { ResolvedProvider } from './provider.js';
import type { ModelPrice } from './prices.js';
import {
  dirHasCredentials, detectAuth, hasKeychainCredentials, readAccount, type AuthMode,
} from './preflight.js';
import { combineBasis, costBasisOf } from './types.js';
import { describeCadence, nextRunAt, nextRuns, validateCadence, type Cadence } from './schedule.js';
import {
  DEFAULT_SCHEDULED_MONTHLY_CAP_USD, afterRunOutcome, decideTicks, monthlyScheduledSpend,
} from './schedule-guards.js';
import type {
  ChatMeta, CostBasis, ForemanEvent, MissionProposal, ModelChoice, Project, ProviderRef, RunMeta, Schedule, ToolPolicy,
} from './types.js';

/**
 * Curated model list for the composer pickers (GET /models). `id` is exactly
 * what the SDK receives as `options.model`.
 */
const MODELS = ANTHROPIC_MODELS;

/**
 * The billing mode one project will actually use. `own-login` means the pinned
 * config dir's stored login pays, so a dir without one is a misconfiguration
 * worth surfacing before a mission starts rather than after it fails.
 */
async function projectBilling(p: Project, serverMode: AuthMode): Promise<BillingMode> {
  const resolved = await resolveProvider(providerOf(p), store.root);
  // A gateway provider bills its own upstream, never the server's Anthropic
  // credential — reporting the server's mode there would name the wrong payer.
  if (resolved.wire !== 'anthropic-native') {
    if (!resolved.apiKey) return 'none';
    // Loopback means the model is served from this machine: no per-token cost,
    // which is why this run's budget caps on turns and time instead.
    return isLoopback(resolved.upstreamUrl) ? 'local' : 'provider';
  }
  if (resolved.kind === 'anthropic-api') return resolved.apiKey ? 'api-key' : 'none';
  if (!resolved.ownLogin) return serverMode;
  return (await dirHasCredentials(resolved.configDir)) ? 'subscription' : 'none';
}

/**
 * Fleet order. Insertion order answers "when did I link this", which is the
 * one question nobody asks; these cards are a control surface, so the order
 * is urgency, then liveness, then recency:
 *
 *   1. projects with an agent blocked on a human (approval or question)
 *   2. projects with a mission running
 *   3. everything else, most recently active first
 *
 * Within a tier the sort is by last activity too, so a card only moves when
 * its state actually changed — a project does not drift under the cursor.
 */
function fleetTier(c: { pendingPermissions: number; pendingQuestions: number; activeRun: unknown }): number {
  if (c.pendingPermissions + c.pendingQuestions > 0) return 0;
  return c.activeRun ? 1 : 2;
}

function fleetOrder(
  a: { pendingPermissions: number; pendingQuestions: number; activeRun: unknown; lastActivityAt: number },
  b: { pendingPermissions: number; pendingQuestions: number; activeRun: unknown; lastActivityAt: number },
): number {
  return fleetTier(a) - fleetTier(b) || b.lastActivityAt - a.lastActivityAt;
}

/**
 * Parses a provider from a request body.
 *
 * The union is the product's safety property — "subscription login" and
 * "custom base URL" must not be expressible together — so it is validated
 * here, at the boundary, rather than trusted from a client. Anything
 * unrecognised is rejected outright: silently coercing a malformed provider to
 * `claude-code` would run a mission on a credential nobody chose.
 *
 * Returns `null` for "not supplied" and a string for "supplied but wrong".
 */
function parseProvider(v: unknown): ProviderRef | null | string {
  if (v === undefined) return null;
  if (v === null) return null; // an explicit clear; the caller distinguishes
  if (typeof v !== 'object') return 'provider must be an object';
  const p = v as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const raw = p[k];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  };

  switch (p.kind) {
    case 'claude-code':
      return {
        kind: 'claude-code',
        ...(str('configDir') ? { configDir: str('configDir')! } : {}),
        ...(str('executable') ? { executable: str('executable')! } : {}),
        ...(p.ownLogin === true ? { ownLogin: true } : {}),
      };
    case 'anthropic-api': {
      const apiKeyEnv = str('apiKeyEnv');
      if (!apiKeyEnv) return 'anthropic-api needs apiKeyEnv';
      return { kind: 'anthropic-api', id: str('id') ?? newProviderId(), apiKeyEnv, model: str('model') };
    }
    case 'codex':
      return {
        kind: 'codex', id: str('id') ?? newProviderId(),
        codexHome: str('codexHome'), upstreamUrl: str('upstreamUrl'), model: str('model'),
      };
    case 'openai-compatible': {
      const baseUrl = str('baseUrl');
      if (!baseUrl) return 'openai-compatible needs baseUrl';
      // Reject a URL the gateway would choke on before it reaches a run,
      // rather than after the agent's first call fails.
      try {
        new URL(normalizeOpenAiBaseUrl(baseUrl));
      } catch {
        return `not a usable base URL: ${baseUrl}`;
      }
      return {
        kind: 'openai-compatible', id: str('id') ?? newProviderId(),
        baseUrl: normalizeOpenAiBaseUrl(baseUrl),
        apiKeyEnv: str('apiKeyEnv'), label: str('label'), model: str('model'),
        ...(p.needsKey === true ? { needsKey: true } : {}),
      };
    }
    default:
      return `unknown provider kind: ${String(p.kind)}`;
  }
}

/** Names a provider's Foreman-owned config dir; stable for its lifetime. */
function newProviderId(): string {
  return `pr-${crypto.randomBytes(4).toString('hex')}`;
}

/** A basis and the deprecated boolean that shadows it, so they cannot drift. */
function basisOf(costBasis: CostBasis): { costBasis: CostBasis; metered: boolean } {
  return { costBasis, metered: costBasis === 'priced' };
}

/** Billing modes the UI understands; a superset of the server's own AuthMode. */
type BillingMode = AuthMode | 'local' | 'provider';

/** One selectable model, tagged with the provider that serves it. */
interface ModelOption {
  id: string;
  label: string;
  model: string;
  /** Which provider serves it; absent means the project's own/server default. */
  providerId?: string;
  providerLabel: string;
  cost?: number;
  note?: string;
  /** Its track record on this machine, from the run ledger; absent until it has one. */
  record?: string;
  /** What spending on this model is: priced, free, or real-but-unquantified. */
  costBasis: CostBasis;
  /** @deprecated Mirrors `costBasis === 'priced'` for older clients. */
  metered: boolean;
}

/**
 * Everything this machine can run a mission on.
 *
 * Deliberately generous: a provider that is merely *present* is offered, even
 * if the current project does not use it, because the picker is where someone
 * decides to use it. Anything unreachable is simply absent rather than listed
 * and broken — a picker's job is to offer what will work.
 */
async function availableModels(project: Project | null): Promise<{
  models: ModelOption[];
  groups: Array<{ providerId?: string; label: string; count: number }>;
  reachable: boolean;
}> {
  const out: ModelOption[] = [];
  // The ledger, read back: each model's record across every run on this
  // machine, attached as one line so the picker and the planner can weigh
  // "cheap" against "finished last time".
  const records = modelRecords(await store.listRuns().catch(() => []));
  const withRecord = (m: ModelOption): ModelOption => {
    const r = records.get(m.id) ?? records.get(m.model) ?? records.get(m.label);
    const line = recordLine(r);
    return line ? { ...m, record: line } : m;
  };

  // Anthropic, via whichever Claude Code install or key the server resolves.
  // Always offered: it is the default, and the shipped configuration.
  for (const m of MODELS) {
    out.push({ ...m, providerLabel: 'Anthropic', costBasis: 'priced', metered: true });
  }

  // The project's own provider, when it is an endpoint of its own. Asked
  // first-hand, because a project pointed at another machine must be offered
  // that machine's models rather than this one's.
  const pinned = project ? providerOf(project) : null;
  if (pinned?.kind === 'openai-compatible') {
    const resolved = await resolveProvider(pinned, store.root);
    const found = await discoverModels(resolved.upstreamUrl ?? pinned.baseUrl, {
      apiKey: resolved.apiKey,
    });
    const onOpenAi = isOpenAiHost(resolved.upstreamUrl);
    for (const raw of found ?? []) {
      // Direct OpenAI publishes no rates; the dated list in openai-prices.ts
      // stands in, and says so in the note. A published rate still wins.
      const listed = onOpenAi && !raw.price ? openaiPrice(raw.id) : null;
      const m = listed ? { ...raw, price: listed } : raw;
      out.push({
        id: m.id, label: m.id, model: m.id,
        providerId: pinned.id, providerLabel: pinned.label ?? 'Custom endpoint',
        cost: costRank(m), note: listed ? (openaiPriceNote(m.id) ?? describeModel(m)) : describeModel(m),
        // Three-way, in the order the facts outrank each other. A published
        // rate settles it. Otherwise the endpoint sets the floor and the model
        // can raise it: a daemon on this machine is free, but a `:cloud` model
        // it merely proxies runs on somebody's paid servers, and calling that
        // free is the error that costs money.
        ...basisOf(m.price ? 'priced'
          : m.remote || !isLoopback(resolved.upstreamUrl) ? 'unpriced' : 'free'),
      });
    }
  }

  // A running local Ollama, whether or not any project uses it yet.
  const localOllama = pinned?.kind === 'openai-compatible'
    && normalizeOpenAiBaseUrl(pinned.baseUrl) === normalizeOpenAiBaseUrl(ollamaHost());
  if (!localOllama) {
    const models = await discoverOllama();
    for (const m of models ?? []) {
      out.push({
        id: m.id, label: m.id, model: m.id,
        providerId: 'ollama-local', providerLabel: 'Ollama',
        cost: costRank(m), note: describeModel(m),
        // A model served from this machine costs nothing per token; a `:cloud`
        // one is real spend Foreman cannot price. Neither gets a dollar
        // figure, but they are not the same thing to tell someone.
        ...basisOf(m.remote ? 'unpriced' : 'free'),
      });
    }
  }

  // A signed-in Codex install.
  const home = codexHome();
  const codexAuth = await readCodexAuth(home).catch(() => null);
  if (codexAuth) {
    for (const id of await codexModels(home)) {
      out.push({
        id, label: id, model: id,
        providerId: 'codex-local', providerLabel: 'Codex',
        cost: 2, note: 'Runs on your ChatGPT subscription.',
        // A plan being drawn down, not a free lunch.
        ...basisOf('unpriced'),
      });
    }
  }

  const groups = [...new Map(out.map((m) => [m.providerLabel, m])).values()]
    .map((m) => ({
      providerId: m.providerId,
      label: m.providerLabel,
      count: out.filter((x) => x.providerLabel === m.providerLabel).length,
    }));

  return { models: out.map(withRecord), groups, reachable: true };
}

/**
 * The provider serving one role.
 *
 * A model carries the provider that serves it, so a run can put its director
 * on one and its workers on another. An id that no longer resolves falls back
 * to the run's own provider rather than failing: a provider removed between
 * dispatch and resume should degrade to the project's, not strand the run.
 */
function providerForRole(meta: RunMeta, roleProviderId?: string): ProviderRef {
  const own = providerOf(meta);
  if (!roleProviderId) return own;
  if ('id' in own && own.id === roleProviderId) return own;
  // The two providers the machine offers without being configured for them.
  if (roleProviderId === 'ollama-local') return ollamaProvider();
  if (roleProviderId === 'codex-local') return { kind: 'codex', id: 'codex-local' };
  return own;
}


/**
 * The one provider problem `resolveProvider` cannot see: a Claude Code
 * provider whose install is not signed in. Resolution only names the config
 * dir; whether anything is logged into it is a fact about the machine, read
 * fresh here so a login done a minute ago counts. Said in Foreman's words,
 * because the SDK's own — "Not logged in · Please run /login" — reads like a
 * Foreman slash command and names nothing the person can do from here.
 */
async function signedInProblem(resolved: ResolvedProvider): Promise<string | null> {
  if (resolved.kind !== 'claude-code') return null;
  const signedIn = resolved.ownLogin
    ? await dirHasCredentials(resolved.configDir)
    : (await detectAuth()).mode !== 'none';
  if (signedIn) return null;
  return 'Claude Code is not signed in on this machine, so nothing can run on it yet. ' +
    'Sign in — run `claude` in a terminal, then `/login` — and restart Foreman; ' +
    'or give this project a provider of its own (an Anthropic API key, Codex, or an OpenAI-compatible endpoint) in Settings → Provider.';
}

/** Whether a project's provider has a key on file. Never the key itself. */
async function providerHasKeyOf(p: Project): Promise<boolean> {
  const ref = providerOf(p);
  return 'id' in ref && ref.id ? hasSecret(store.root, ref.id) : false;
}

/** Is this endpoint on this machine? Decides "free" from "somebody's meter". */
function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Trims an optional path field from a request body; '' means "cleared". */
function toPath(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * A model id from any provider.
 *
 * This used to accept only Anthropic aliases and `claude-*` ids, which meant a
 * picked Ollama or Codex model was silently dropped and the run quietly fell
 * back to the default — the failure looked like a successful mission on the
 * wrong model. Now that a model carries the provider that serves it, the
 * shapes are whatever those providers use (`glm-5.3-flash:cloud`,
 * `gpt-5.6-sol`, `qwen3.8:27b-q8_0`), so this validates the *characters* a
 * model id may contain rather than trying to recognise a vendor.
 */
function modelChoice(v: unknown): ModelChoice {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const id = v.trim();
  return /^[A-Za-z0-9._:\/-]{1,120}$/.test(id) ? id : undefined;
}

/** Directory names never descended into by the drag-drop folder locator. */
const LOCATE_SKIP = new Set([
  'node_modules', 'Library', 'Applications', '.Trash', 'Music', 'Movies',
  'Pictures', 'dist', 'build', 'target', 'vendor', '.git',
]);

/**
 * Breadth-first search under $HOME for directories whose basename matches
 * `name` (case-insensitive). Bounded by depth, visit count, and wall clock so
 * a request can never wander the whole disk.
 */
async function locateFolders(name: string): Promise<string[]> {
  const wanted = name.toLowerCase();
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: os.homedir(), depth: 0 }];
  const deadline = Date.now() + 2000;
  let visited = 0;

  while (queue.length && results.length < 15 && visited < 20000 && Date.now() < deadline) {
    const { dir, depth } = queue.shift()!;
    visited++;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || LOCATE_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase() === wanted) results.push(full);
      if (depth < 4) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return results;
}

const PORT = Number(process.env.PORT ?? 4177);
/**
 * Where the dev servers the crew exposed are proxied — a second port, and so a
 * second origin. Those pages are written by an agent, and a browser gives a
 * page the run of every API on its own origin: served from Foreman's port, an
 * exposed preview could start missions, read the folder tree and spend the
 * budget with a line of fetch(). On a port of its own the same-origin policy
 * does that refusing for us. FOREMAN_SERVICES_PORT overrides; PORT + 1 by default.
 */
const SERVICES_PORT = (() => {
  const raw = process.env.FOREMAN_SERVICES_PORT;
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : PORT + 1;
})();
/**
 * Where to listen. Default: loopback, plus the tailnet address when this
 * machine is on one — never every interface, since there is no login.
 * `FOREMAN_BIND=all` opens it wide on purpose (a trusted LAN, a container);
 * `FOREMAN_BIND=local` keeps it to this machine even with Tailscale up.
 */
const BIND = (process.env.FOREMAN_BIND ?? 'auto') as 'auto' | 'all' | 'local';
const tailnet = BIND === 'local' ? null : await detectTailscale(PORT);
/** Dev servers the crew put behind /svc/ — see services.ts. */
const services = new ServiceRegistry();
/**
 * Whether a newer Foreman exists, for the header's quiet pill. Checked at
 * start and every six hours, never acted on: updating is `foreman update`,
 * by hand, and never under a running mission.
 */
let updateInfo: UpdateInfo | null = null;
const refreshUpdateInfo = () => { void checkForUpdate(currentVersion(), 4_000).then((u) => { updateInfo = u; }); };
refreshUpdateInfo();
setInterval(refreshUpdateInfo, 6 * 60 * 60_000).unref();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'ui', 'dist');
const ROOT_ASSETS = new Set(['/favicon.svg']);

const store = new RunStore(process.env.FOREMAN_HOME || undefined);

/** Detected once: env is immutable for this process, and /projects polls at 3s. */
const authPromise = detectAuth();
/**
 * Live runs by projectId, then by reservation ticket; `null` marks a
 * reservation taken synchronously before the run object exists.
 *
 * A map per project rather than one run each, because a `worktree` project may
 * run several missions at once — see src/isolation.ts, which owns every rule
 * about how many. The ticket is what keeps that honest: a slot is released by
 * the ticket that took it, so one mission ending can never drop another's
 * entry, and a `shared` project — pinned at a limit of 1 — behaves exactly as
 * it always did.
 */
const activeByProject = new Map<string, Map<string, MissionRun | null>>();
const sseClients = new Set<http.ServerResponse>();

/**
 * A comment frame down every open stream, often enough that nothing in the
 * middle calls the connection dead.
 *
 * A quiet fleet produces no events for minutes at a time, and an idle stream
 * is exactly what proxies (`tailscale serve`, anything else in front) and
 * phone radios reclaim — the dashboard then sits there looking live while
 * receiving nothing. `:` starts a comment in the SSE grammar, so this costs
 * the client nothing to parse and never reaches an event handler. Unref'd:
 * it must not be the reason the process stays up. Clients that have gone
 * away are dropped here rather than waiting for a real event to notice.
 */
setInterval(() => {
  for (const res of sseClients) {
    if (res.destroyed || res.writableEnded) { sseClients.delete(res); continue; }
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 25_000).unref();

function activeRuns(): MissionRun[] {
  // Flattened across projects, reservation placeholders filtered out (see
  // reserveProject).
  const out: MissionRun[] = [];
  for (const slots of activeByProject.values()) {
    for (const run of slots.values()) if (run) out.push(run);
  }
  return out;
}

/** One project's attached runs, newest first. A reservation is not a run yet. */
function liveRunsOf(projectId: string): MissionRun[] {
  const slots = activeByProject.get(projectId);
  if (!slots) return [];
  return [...slots.values()]
    .filter((r): r is MissionRun => Boolean(r))
    .sort((a, b) => b.meta.createdAt - a.meta.createdAt);
}

/**
 * How many missions this project is holding — reservations INCLUDED.
 *
 * A placeholder has to count, or two requests arriving before either has a run
 * object would read the same count and both pass the limit: the reservation is
 * the whole reason the check is race-free.
 */
function liveCountOf(projectId: string): number {
  return activeByProject.get(projectId)?.size ?? 0;
}

/**
 * Where each reservation's mission works, by ticket: its own worktree, or the
 * project's checkout.
 *
 * Kept beside the reservation rather than read off the runs, for the same
 * reason the reservation exists at all — a run is not attached until seconds
 * after it is reserved, and the question "is anyone already working in the
 * project folder?" has to be answerable in that window. Written in
 * reserveProject and dropped in releaseProject, the only two places a slot is
 * taken or given back, so it cannot outlive its ticket.
 */
const reservedWorkspaces = new Map<string, Isolation>();

/**
 * How many live missions in this project are working in the project's own
 * checkout. Worktree runs are not among them — that is the point of them.
 */
function sharedLiveOf(projectId: string): number {
  let n = 0;
  for (const ticket of activeByProject.get(projectId)?.keys() ?? []) {
    if (reservedWorkspaces.get(ticket) !== 'worktree') n += 1;
  }
  return n;
}

/**
 * A dispatch nobody waits for, whose reservation cannot leak.
 *
 * driveRun gives the ticket back on every path it owns, but startRun and
 * resumeRun do real work on the way there — a settings read, a git call, a
 * mission doc restored — and a throw in any of it would leave the slot held
 * for the life of the process: a project one mission short for ever, with
 * nothing on screen to say why. Releasing here is safe even when driveRun
 * already did it; releaseProject is idempotent.
 */
function dispatch(projectId: string, ticket: string, started: Promise<void>): void {
  void started.catch((err) => {
    console.error(`dispatch for project ${projectId} failed:`, err);
    releaseProject(projectId, ticket);
  });
}

/** The run that filled a reservation, under the ticket that took it. */
function attachRun(projectId: string, ticket: string, run: MissionRun): void {
  const slots = activeByProject.get(projectId) ?? new Map<string, MissionRun | null>();
  slots.set(ticket, run);
  activeByProject.set(projectId, slots);
}

/**
 * Gives one reservation back. Idempotent, and the project's map goes when its
 * last slot does, so `activeByProject` holds only projects with something live
 * in them and `has(projectId)` still reads as "a mission is running here".
 */
function releaseProject(projectId: string, ticket: string): void {
  reservedWorkspaces.delete(ticket);
  const slots = activeByProject.get(projectId);
  if (!slots) return;
  slots.delete(ticket);
  if (!slots.size) activeByProject.delete(projectId);
}

/**
 * The metadata of every run this process is currently driving, by run id.
 *
 * The emitter has to answer "was this run started by a schedule?" at the
 * instant it emits, and a run's `run_finished` can be emitted before the
 * MissionRun object exists at all (a provider that will not resolve fails the
 * run in driveRun's first few lines). Reading meta.json back there would be
 * asynchronous, and the notification envelope has already gone out by then.
 */
const drivingRuns = new Map<string, RunMeta>();

/**
 * Schedule names by schedule id, so a notification can say which standing
 * instruction started a run without a disk read on the emitter's path. Filled
 * wherever schedules are loaded anyway — every ticker pass, and each dispatch.
 */
const scheduleNames = new Map<string, string>();

/**
 * What happened in the fleet lately, in one line each, for the front desk.
 *
 * In memory only: it exists so the fleet planner can open with the news
 * instead of asking, and the news is by definition recent. A restart
 * empties it and says so. Two hundred lines outlast any plausible gap
 * between two phone messages.
 */
const SERVER_STARTED_AT = Date.now();
const fleetLog: Array<{ ts: number; projectId: string; text: string }> = [];
function noteFleetEvent(projectId: string, event: string, d: Record<string, unknown>): void {
  const short = (v: unknown, n = 90): string => { const t = String(v ?? '').split('\n')[0].trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  let text: string | null = null;
  switch (event) {
    case 'run_started': text = `mission started: "${short(d.mission)}"`; break;
    case 'run_resumed': text = 'mission resumed'; break;
    case 'run_finished': text = `mission ended: ${d.status}${typeof d.costUsd === 'number' ? ` ($${(d.costUsd as number).toFixed(2)})` : ''}`; break;
    case 'run_error': text = `run error: ${short(d.error, 120)}`; break;
    case 'mission_incomplete': text = `ended with boxes unticked: ${short(d.text, 120)}`; break;
    case 'permission_request': text = `${d.agent ?? 'the crew'} asked to use ${d.toolName ?? d.tool ?? 'a tool'} — waiting on the human`; break;
    case 'question': text = `${d.agent ?? 'the director'} asked the human: "${short(d.question)}"`; break;
    case 'worker_stalled': text = `a worker stalled: ${short(d.text, 100)}`; break;
    case 'service_exposed': text = `service up: ${short(d.label)} at ${d.url ?? ''}`; break;
    case 'mission_proposed': text = `a mission was proposed (cap $${d.budgetUsd}): "${short(d.mission)}"`; break;
    case 'mission_started': text = 'the proposal was started as a mission'; break;
    case 'chat_proposal_dismissed': text = 'the proposal was discarded'; break;
  }
  if (!text) return;
  fleetLog.push({ ts: Date.now(), projectId, text });
  if (fleetLog.length > 200) fleetLog.splice(0, fleetLog.length - 200);
}

/** The news since `since`, as lines for the front desk's prompt. */
function fleetNews(since: number, max = 12): string[] {
  const hhmm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const lines = fleetLog.filter((e) => e.ts > since && e.projectId !== FLEET_CHAT_ID)
    .map((e) => `${hhmm(e.ts)} ${projectsCache.get(e.projectId)?.name ?? e.projectId} — ${e.text}`);
  const out = lines.slice(-max);
  if (lines.length > max) out.unshift(`(${lines.length - max} earlier lines not shown)`);
  if (SERVER_STARTED_AT > since) out.unshift(`Foreman restarted at ${hhmm(SERVER_STARTED_AT)}; anything before that is not listed here (the tools still know).`);
  return out;
}

function makeEmitter(runId: string, projectId: string) {
  return (event: string, data: unknown): void => {
    const evt: ForemanEvent = { ts: Date.now(), event, data };
    const frame =
      `event: ${event}\ndata: ${JSON.stringify({ runId, projectId, data })}\n\n`;
    for (const res of sseClients) res.write(frame);
    void store.append(runId, evt);
    noteFleetEvent(projectId, event, (data ?? {}) as Record<string, unknown>);
    // The one place notifications hang off the mission stream. Labels are
    // cached here from the events themselves so a message can name the run
    // without a disk read on the emitter's path.
    const d = (data ?? {}) as Record<string, unknown>;
    if (event === 'run_started' || event === 'run_resumed') {
      runLabelCache.set(runId, { ...runLabelCache.get(runId), mission: String(d.mission ?? '') });
    } else if (event === 'run_titled') {
      runLabelCache.set(runId, { ...runLabelCache.get(runId), title: String(d.title ?? '') });
      // The branch was named from the brief before the title existed; now it
      // can carry the title. Only while it is still the brief-derived name and
      // nothing is committed on it — the mission's first turns.
      const run = activeRuns().find((r) => r.meta.id === runId);
      const title = String(d.title ?? '').trim();
      if (run?.meta.git && title && run.meta.git.branch === missionBranchName(run.meta.mission, runId) && !(run.meta.git.commits)) {
        void renameMissionBranch(run.meta.folder, run.meta.git.branch, title, runId).then(async (renamed) => {
          if (!renamed || !run.meta.git) return;
          const was = run.meta.git.branch;
          run.meta.git = { ...run.meta.git, branch: renamed };
          await store.writeMeta(run.meta).catch(() => {});
          gitInfoCache.delete(run.meta.folder);
          makeEmitter(runId, projectId)('git_branch', { branch: renamed, base: run.meta.git.base, text: `Branch renamed to ${renamed} (was ${was}) now that the run has a title.` });
        });
      }
    }
    // The end of a scheduled run is also the schedule's news: the phone should
    // say nobody pressed start, and the schedule's own failure bookkeeping has
    // to move on. This is where the server learns a run ended — the
    // orchestrator knows nothing about schedules and should not.
    if (event === 'run_finished') {
      const meta = drivingRuns.get(runId) ?? activeRuns().find((r) => r.meta.id === runId)?.meta;
      if (meta?.scheduleId) {
        d.scheduled = true;
        const name = scheduleNames.get(meta.scheduleId);
        if (name) d.scheduleName = name;
        void recordScheduleOutcome(meta.scheduleId, meta).catch((err) => {
          console.error(`failed to record outcome of schedule ${meta.scheduleId}:`, err);
        });
      }
    }
    if (!projectsCache.has(projectId)) {
      void store.getProject(projectId).then((p) => { if (p) projectsCache.set(projectId, { name: p.name }); });
    }
    notifyHub.handle({ event, runId, projectId, data: d, ts: evt.ts });
  };
}

/**
 * An announcement about a schedule rather than about a run.
 *
 * A skipped or auto-paused schedule has no run to hang a line off — that is
 * exactly what happened: nothing started. So the frame carries `runId: null`,
 * goes nowhere near a run's event log, and otherwise travels the same three
 * roads every other event does (open tabs, the front desk's news, the phone).
 */
function scheduleNotice(projectId: string) {
  return (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify({ runId: null, projectId, data })}\n\n`;
    for (const res of sseClients) res.write(frame);
    const d = (data ?? {}) as Record<string, unknown>;
    noteFleetEvent(projectId, event, d);
    notifyHub.handle({ event, runId: null, projectId, data: d, ts: Date.now() });
  };
}

/**
 * Everything an agent needs to authenticate, including starting the provider's
 * gateway if it has one.
 *
 * Both dispatch paths (missions and planning turns) go through here, so a
 * gateway can never be skipped on one of them — which would leave the agent
 * pointed at a closed port with a real credential in hand.
 */
async function agentEnvFor(
  resolved: ResolvedProvider, holder?: string, ledgerKey?: string,
): Promise<ReturnType<typeof providerEnv>> {
  await mkdir(resolved.configDir, { recursive: true }).catch(() => {});
  if (resolved.wire === 'anthropic-native') return providerEnv(resolved);
  // `holder` keeps the gateway alive for as long as this run needs it — see
  // the reaper in gateway.ts.
  const url = await ensureGateway(resolved, holder);
  // The run key rides on the path, which the Agent SDK preserves (measured:
  // it sends `POST /run/<key>/v1/messages`). That is what lets one gateway
  // serving several runs still say which one spent what.
  return providerEnv(resolved, ledgerKey ? `${url}/run/${encodeURIComponent(ledgerKey)}` : url);
}

/**
 * An agent env per crew preset that named a provider of its own, keyed by
 * preset id — the third kind of env a run can need, after its two roles. A
 * reviewer pinned to another provider is a real request: the point of a second
 * opinion is partly that it comes from a different model, and a model carries
 * its provider.
 *
 * Only presets that name a `providerId` get an entry, and only when that
 * provider resolves cleanly. Anything else — no id, an id nothing resolves,
 * a resolution `providerProblem` calls unusable — is LEFT OUT rather than
 * reported, because a missing entry means the reviewer runs on the worker env
 * and a thrown error means the run dies. A provider deleted between the moment
 * a human chose the crew and the moment the director asks for the review must
 * degrade to the worker's provider: the alternative is a mission stranded at
 * the one step that would let it be recorded as done, over a credential its
 * reviewer never strictly needed.
 *
 * Each preset's env carries the preset's own model for the same reason the two
 * roles do — the SDK's aliases have to resolve to something this provider's
 * gateway serves — and shares the run's ledger key, since the reviewer's
 * tokens are accounted to the worker role. See the `env` comment in
 * orchestrator.ts's requestReviewTool for why that approximation is chosen.
 */
/**
 * Each crew preset's own cost basis, by preset id — for the presets that name
 * a provider Foreman can resolve, which are the ones that will run somewhere
 * other than the worker role.
 *
 * The run needs this to count a review's spend honestly. A reviewer pinned to
 * a paid provider beside workers on a free gateway had its dollars discarded,
 * because cost was attributed to the worker role and a gateway role's figures
 * are dropped by design. Whether money is real is the provider's answer, not
 * the role's.
 */
async function crewBasesFor(meta: RunMeta): Promise<Record<string, { basis: CostBasis; native: boolean }> | undefined> {
  const wanted = (meta.crew ?? []).filter((p) => p.providerId);
  if (!wanted.length) return undefined;
  const out: Record<string, { basis: CostBasis; native: boolean }> = {};
  const seen = new Map<string, { basis: CostBasis; native: boolean } | null>();
  for (const preset of wanted) {
    const id = preset.providerId as string;
    if (!seen.has(id)) {
      const ref = providerForRole(meta, id);
      const resolved = 'id' in ref && ref.id === id
        ? await resolveProvider(ref, store.root).catch(() => null)
        : null;
      seen.set(id, resolved && !providerProblem(resolved)
        ? {
          basis: (await roleCost(withRoleModel(resolved, preset.model ?? meta.workerModel), preset.model ?? meta.workerModel)).basis,
          // Whether the SDK's dollar figure for this preset IS the bill, or
          // whether it is a gateway that reports through the run's ledger.
          native: resolved.wire === 'anthropic-native',
        }
        : null);
    }
    const cost = seen.get(id);
    if (cost) out[preset.id] = cost;
  }
  return Object.keys(out).length ? out : undefined;
}

async function crewEnvsFor(
  meta: RunMeta, ledgerKey: string,
): Promise<Record<string, ReturnType<typeof providerEnv>> | undefined> {
  const wanted = (meta.crew ?? []).filter((p) => p.providerId);
  if (!wanted.length) return undefined;
  // One resolution per distinct provider, not per preset: two reviewers on the
  // same endpoint are one credential and one gateway.
  const bases = new Map<string, ResolvedProvider | null>();
  const out: Record<string, ReturnType<typeof providerEnv>> = {};
  for (const preset of wanted) {
    const id = preset.providerId as string;
    if (!bases.has(id)) {
      const ref = providerForRole(meta, id);
      // providerForRole answers with the RUN's provider when the id resolves to
      // nothing it knows. That is the right answer for a role, which must run
      // somewhere; here it would quietly pin the preset to a provider nobody
      // asked for, so it counts as "no entry" instead.
      const resolved = 'id' in ref && ref.id === id
        ? await resolveProvider(ref, store.root).catch(() => null)
        : null;
      bases.set(id, resolved && !providerProblem(resolved) ? resolved : null);
    }
    const base = bases.get(id);
    if (!base) continue;
    const withModel = withRoleModel(base, preset.model ?? meta.workerModel);
    if (providerProblem(withModel)) continue;
    // A gateway that will not start is the same kind of nothing: the reviewer
    // falls back rather than the run failing.
    const env = await agentEnvFor(withModel, meta.id, ledgerKey).catch(() => null);
    if (env) out[preset.id] = env;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The ledger bucket for this attempt at a run.
 *
 * The attempt number is part of the key on purpose. A gateway can outlive the
 * run that started it, so a resumed run whose earlier tokens are already
 * persisted in `meta.usage` would otherwise read them back out of the ledger
 * and count them twice. A fresh bucket per attempt makes "persisted total plus
 * what this attempt has spent" exactly right.
 */
function ledgerKeyFor(meta: RunMeta): string {
  return `${meta.id}.${meta.resumes ?? 0}`;
}

/**
 * A chat event for open tabs only, not the log: the log it would describe
 * is the one being thrown away. Used when a conversation is cleared, so a
 * tab still showing the old proposal and cost drops them.
 */
function broadcastChat(projectId: string, event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify({ runId: null, projectId, chat: true, data })}\n\n`;
  for (const res of sseClients) res.write(frame);
  noteFleetEvent(projectId, event, (data ?? {}) as Record<string, unknown>);
}

function makeChatEmitter(projectId: string) {
  return (event: string, data: unknown): void => {
    const evt: ForemanEvent = { ts: Date.now(), event, data };
    const frame =
      `event: ${event}\ndata: ${JSON.stringify({ runId: null, projectId, chat: true, data })}\n\n`;
    for (const res of sseClients) res.write(frame);
    void store.appendChat(projectId, evt);
    noteFleetEvent(projectId, event, (data ?? {}) as Record<string, unknown>);
    if (!projectsCache.has(projectId)) {
      void store.getProject(projectId).then((p) => { if (p) projectsCache.set(projectId, { name: p.name }); });
    }
    notifyHub.handle({ event, runId: null, projectId, chat: true, data: (data ?? {}) as Record<string, unknown>, ts: evt.ts });
  };
}

/**
 * Projects with a planning turn in flight. One turn at a time per project:
 * two concurrent turns would resume the same session and race to write the
 * session id, quietly forking the conversation.
 */
const chatTurns = new Set<string>();
/** The in-flight turn's abort handle per project, so a human can stop it. */
const chatAborts = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Global settings the channel reads: the same toggles the tab uses, plus where links point. */
async function notifySettings(): Promise<{
  prefs: { needsYou: boolean; done: boolean; budget: boolean };
  publicUrl: string;
  telegramChatId?: string; telegramChatLabel?: string; telegramBot?: string;
}> {
  const g = (await store.readSettings().catch(() => ({ global: {}, projects: {} }))).global as Record<string, unknown>;
  const on = (k: string, dflt: boolean) => (typeof g[k] === 'boolean' ? (g[k] as boolean) : dflt);
  const str = (k: string) => (typeof g[k] === 'string' && (g[k] as string).trim() ? (g[k] as string).trim() : undefined);
  return {
    prefs: { needsYou: on('notifyNeedsYou', true), done: on('notifyDone', true), budget: on('notifyBudget', true) },
    // Unset: the tailnet name when there is one — the phone can open that —
    // else localhost, which only this machine can.
    publicUrl: (() => {
      const saved = str('publicUrl');
      // A saved localhost is the old default, not a preference: no phone can
      // open it, so a tailnet name wins over it. Any other saved URL stands.
      const isLocal = !saved || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(saved);
      return ((isLocal && tailnet) ? tailnetUrl(tailnet, PORT) : (saved ?? `http://localhost:${PORT}`)).replace(/\/+$/, '');
    })(),
    telegramChatId: str('telegramChatId'),
    telegramChatLabel: str('telegramChatLabel'),
    telegramBot: str('telegramBot'),
  };
}

/**
 * The context the hub shapes messages with. Read per event rather than cached
 * so a Settings change — a toggle, a new public URL — applies to the next
 * message, and so the project and run names come from live state. Cheap: a
 * small JSON file and two Map lookups, on events that happen a few times a
 * mission.
 */
let notifyCtxCache: { at: number; value: Awaited<ReturnType<typeof notifySettings>> } | null = null;
const notifyHub = new NotifyHub(() => {
  const s = notifyCtxCache?.value ?? { prefs: { needsYou: true, done: true, budget: true }, publicUrl: tailnet ? tailnetUrl(tailnet, PORT) : `http://localhost:${PORT}` };
  if (!notifyCtxCache || Date.now() - notifyCtxCache.at > 5_000) {
    void notifySettings().then((v) => { notifyCtxCache = { at: Date.now(), value: v }; });
  }
  return {
    prefs: s.prefs,
    publicUrl: s.publicUrl,
    projectName: (id) => projectsCache.get(id)?.name,
    runLabel: (id) => { const r = runLabelCache.get(id); return r?.title || r?.mission; },
  };
});
const projectsCache = new Map<string, { name: string }>();
const runLabelCache = new Map<string, { title?: string; mission?: string }>();

/**
 * The one reader of the bot's updates — link codes, button taps, replies.
 * Created whenever a token exists (linking needs it before any chat is
 * linked); the transport is attached only once a chat is.
 */
let telegramBot: TelegramBot | null = null;

/** (Re)build the Telegram side from the stored token and linked chat. */
async function reattachTelegram(): Promise<boolean> {
  notifyHub.detach('telegram');
  // A second server beside the installed one (a dev checkout on another
  // port) must not start a second poller: Telegram allows one per bot, and
  // two fight over getUpdates. FOREMAN_NO_TELEGRAM=1 leaves the channel to
  // whichever server does not set it.
  if (process.env.FOREMAN_NO_TELEGRAM === '1') return false;
  const s = await notifySettings();
  const token = await getSecret(store.root, 'telegram');
  if (!token) { void telegramBot?.stop(); telegramBot = null; return false; }
  if (!telegramBot) {
    telegramBot = new TelegramBot(token, undefined, s.telegramChatId ?? null, {
      // Taps and replies from the linked chat become the same calls the tab
      // makes, through the hub — the channel never learns Foreman's routes.
      onCallback: (data, messageId) => notifyHub.handleCallback(data, messageId),
      onText: (text, replyTo) => void handlePhoneText(text, replyTo),
    });
    telegramBot.start();
    // The phone's "/" menu. Best effort: a failure here costs the menu, not the bot.
    void setBotCommands(token).then((ok) => { if (!ok) console.warn('[telegram] could not register the command menu'); });
  }
  telegramBot.linkedChatId = s.telegramChatId ?? null;
  if (!s.telegramChatId) return false;
  notifyHub.attach(telegramTransport(token, s.telegramChatId));
  return true;
}

// An answer from the channel resolves exactly as one from the tab would. The
// orchestrator emits the same events, the transcript shows the same entry,
// and the phone's message is edited by that event like any other resolution.
notifyHub.onAnswer((a) => {
  if (a.kind === 'perm') {
    activeRuns().some((r) => r.resolvePermission(a.id, a.behavior));
  } else if (a.kind === 'q') {
    activeRuns().some((r) => r.answerQuestion(a.id, a.text));
  } else if (a.kind === 'cq') {
    if (answerChatQuestion(a.projectId, a.id, a.answers)) {
      makeChatEmitter(a.projectId)('chat_answered', { id: a.id, answers: a.answers, source: 'telegram' });
    }
  } else if (a.kind === 'proposal') {
    void (async () => {
      const project = await store.getProject(a.projectId);
      const meta = await store.readChatMeta(a.projectId).catch(() => null);
      const prop = meta?.proposal;
      if (!project || !prop) { void notifyHub.say('That proposal is no longer there.'); return; }
      if (a.action === 'discard') {
        const { proposal: _gone, ...rest } = meta!;
        await store.writeChatMeta({ ...rest, updatedAt: Date.now() });
        broadcastChat(a.projectId, 'chat_proposal_dismissed', {});
        void notifyHub.say(`Discarded the proposal for <b>${escTg(project.name)}</b>. Tell the planner what to change.`);
        return;
      }
      const iso = await isolationFor(project);
      const reserved = reserveProject(a.projectId, { ...iso, projectName: project.name });
      if ('error' in reserved) { void notifyHub.say(`${escTg(reserved.error)}.`); return; }
      // Exactly what the card in the browser would start: the proposal's
      // brief, its budget, its models and its browser judgement.
      dispatch(a.projectId, reserved.ticket, startRun(a.projectId, reserved.ticket, iso.isolation, project.folder, prop.mission, prop.budgetUsd,
        modelChoice(prop.directorModel), modelChoice(prop.workerModel), prop.browser === true,
        providerOf(project), { director: prop.directorProviderId, worker: prop.workerProviderId },
        { startedBy: 'phone' }));
      void notifyHub.say(`Started <b>${escTg(project.name)}</b> as proposed, cap $${prop.budgetUsd}.`);
    })();
  }
});

/**
 * A gap as a reader would say it: "in 15 h", "3 days ago". Used where a
 * timestamp would make someone do arithmetic on their phone.
 */
function relativeTime(ms: number): string {
  const s = Math.round(ms / 1000);
  const a = Math.abs(s);
  const span = a < 90 ? 'a minute' : a < 5400 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return s >= 0 ? `in ${span}` : `${span} ago`;
}

/** The project the phone last planned with; plain text continues it. */
let lastPhonePlanning: string | null = null;

/** A project by name (case-insensitive), id, or folder basename. */
async function findProject(ref: string): Promise<Project | null> {
  const want = ref.trim().toLowerCase();
  const all = await store.listProjects();
  return all.find((p) => p.id === ref)
    ?? all.find((p) => p.name.toLowerCase() === want)
    ?? all.find((p) => path.basename(p.folder).toLowerCase() === want)
    ?? null;
}

// ---------------------------------------------------------------------------
// Linking a repository: clone under the projects root, then link the folder
// ---------------------------------------------------------------------------

interface CloneJob {
  id: string; url: string; dest: string; startedAt: number;
  state: 'running' | 'done' | 'error'; progress: string; projectId?: string; error?: string;
}
/** Clones in flight or recently finished, for the picker to poll. Memory only; a restart forgets them (the folder stays). */
const cloneJobs = new Map<string, CloneJob>();

interface InstallJob { id: string; what: 'chromium'; startedAt: number; state: 'running' | 'done' | 'error'; progress: string; error?: string }
/** Browser installs started from the setup page; one at a time, polled like a clone. */
const installJobs = new Map<string, InstallJob>();

/**
 * Where a repository lands and whether it may: under the projects root, by
 * its own name, never over something that is already there. Returns the
 * destination or the reason it cannot be used.
 */
async function cloneDestination(url: string): Promise<{ ok: true; ref: NonNullable<ReturnType<typeof parseRepoUrl>>; dest: string } | { ok: false; error: string }> {
  const ref = parseRepoUrl(url);
  if (!ref) return { ok: false, error: `"${url}" is not a Git URL Foreman recognises. Try https://github.com/owner/repo, git@host:owner/repo.git, or owner/repo.` };
  const settings = await store.readSettings().catch(() => ({ global: {}, projects: {} }));
  const root = projectsRoot((settings.global as Record<string, unknown>).projectsRoot);
  const dest = path.join(root, ref.name);
  if (await stat(dest).catch(() => null)) {
    const linked = (await store.listProjects()).find((p) => p.folder === dest);
    return { ok: false, error: linked ? `${ref.name} is already here and linked as ${linked.name}.` : `${dest} already exists. Link that folder instead, or move it aside.` };
  }
  await mkdir(root, { recursive: true });
  return { ok: true, ref, dest };
}

/** Clone and link, start to finish. Used by the front desk and the phone, which wait; the picker uses the job table instead. */
async function cloneAndLink(url: string, branch?: string, onProgress?: (line: string) => void): Promise<{ project?: Project; error?: string }> {
  const where = await cloneDestination(url);
  if (!where.ok) return { error: where.error };
  const failed = await cloneRepo({ ref: where.ref, dest: where.dest, branch, onProgress });
  if (failed) {
    // A half-clone is worse than none: git leaves the folder on failure.
    await rm(where.dest, { recursive: true, force: true }).catch(() => {});
    return { error: failed };
  }
  const project = await store.addProject(where.dest);
  projectsCache.set(project.id, { name: project.name });
  return { project };
}

// ---------------------------------------------------------------------------
// The fleet planner — the front desk
// ---------------------------------------------------------------------------

/** When the phone last spoke to a project planner; decides where plain text goes. */
let lastPhonePlanningAt = 0;
/** The fleet turn in flight, if any. One at a time: it is one session. */
let fleetAbort: AbortController | null = null;

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim())?.trim().slice(0, 100) ?? '';
const runTitle = (m: RunMeta): string => m.title || firstLine(m.mission) || m.id;
const spendLine = (m: RunMeta): string =>
  m.costBasis === 'priced' || m.costBasis === undefined ? `$${m.costUsd.toFixed(2)} of $${m.budgetUsd}` : `${m.costBasis} · cap $${m.budgetUsd}`;
const clipText = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n).trimEnd()} […]`);

/** The director's last words in a run's log: its latest text block, and its result if it ended. */
async function directorWords(runId: string): Promise<{ last?: string; result?: string; error?: string }> {
  const events = await store.readEvents(runId).catch(() => []);
  let last: string | undefined;
  let result: string | undefined;
  let error: string | undefined;
  for (const e of events) {
    if (e.event === 'run_error' || e.event === 'mission_incomplete') {
      const d = e.data as { error?: unknown; text?: unknown } | undefined;
      const t = d?.error ?? d?.text;
      if (typeof t === 'string' && t.trim()) error = t.trim();
      continue;
    }
    if (e.event !== 'message') continue;
    const d = e.data as { agent?: string; msg?: { type?: string; result?: unknown; message?: { content?: Array<{ type?: string; text?: string }> } } } | undefined;
    if (d?.agent !== 'director' || !d.msg) continue;
    if (d.msg.type === 'assistant') {
      for (const b of d.msg.message?.content ?? []) if (b.type === 'text' && b.text?.trim()) last = b.text.trim();
    } else if (d.msg.type === 'result' && typeof d.msg.result === 'string') {
      result = d.msg.result;
    }
  }
  return { last, result, error };
}

/** DONE WHEN progress as the mission doc records it. */
async function boxCount(folder: string): Promise<string> {
  const doc = await readFile(path.join(folder, '.foreman', 'MISSION.md'), 'utf8').catch(() => '');
  const ticked = (doc.match(/^\s*[-*] \[[xX]\]/gm) ?? []).length;
  const open = (doc.match(/^\s*[-*] \[ \]/gm) ?? []).length;
  return ticked + open ? `${ticked} of ${ticked + open} boxes ticked` : 'no checklist yet';
}

/**
 * A project's runs, from a list of every run there is.
 *
 * The owning project is `r.projectId`, and it has to be: since worktree
 * isolation, a run's `folder` is the checkout it worked in, which for such a
 * project is `<FOREMAN_HOME>/worktrees/…` and never the project's own folder.
 * Comparing folders alone silently drops every isolated mission — the run is
 * still there, but "last run", the track record and the planner's budget
 * anchor all report an empty history.
 *
 * The folder still answers for runs recorded before `projectId` existed: those
 * have no owner to compare, and all of them ran in the project folder.
 */
function runsOfProject(runs: readonly RunMeta[], project: { id: string; folder: string }): RunMeta[] {
  return runs.filter((r) => (r.projectId ? r.projectId === project.id : r.folder === project.folder));
}

async function lastRunOf(project: Project): Promise<RunMeta | null> {
  const runs = await store.listRuns().catch(() => [] as RunMeta[]);
  return runsOfProject(runs, project).filter((r) => r.status !== 'running')
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

async function noSuchProject(ref: string): Promise<string> {
  const names = (await store.listProjects()).map((p) => p.name);
  return `No project called "${ref}". Linked projects: ${names.length ? names.join(', ') : 'none yet'}.`;
}

/**
 * The fleet's verbs, as the front desk may use them. Every method answers in
 * words; nothing here starts, stops or resumes a run.
 */
const fleetHost: FleetHost = {
  async listProjects() {
    const all = await store.listProjects();
    const runs = await store.listRuns().catch(() => [] as RunMeta[]);
    const out: FleetProjectView[] = [];
    for (const p of all) {
      // The newest live run stands for the project here: the front desk speaks
      // in sentences, and "what is happening in this project" is the latest.
      const live = liveRunsOf(p.id)[0] ?? null;
      const last = runsOfProject(runs, p).filter((r) => r.status !== 'running').sort((a, b) => b.createdAt - a.createdAt)[0];
      const meta = await store.readChatMeta(p.id).catch(() => null);
      out.push({
        id: p.id, name: p.name, folder: p.folder,
        running: live ? {
          title: runTitle(live.meta), spend: spendLine(live.meta), startedAt: live.meta.createdAt,
          waiting: live.pendingAsks().map((a) => `${a.kind === 'permission' ? 'approval' : 'question'}: ${clipText(a.text, 120)}`),
        } : undefined,
        lastRun: last ? { title: runTitle(last), status: last.status, endedAt: last.endedAt } : undefined,
        proposalWaiting: Boolean(meta?.proposal),
        plannerReplying: chatTurns.has(p.id),
      });
    }
    return out;
  },

  /**
   * The standing schedules, with what they have already cost this month
   * against their project's ceiling — the number that decides whether the next
   * unattended firing happens at all, and the one nobody can see from a phone.
   *
   * Reading only, like every other verb here. An unknown reference is an
   * error rather than an empty list: "no schedules" and "you named a project
   * that does not exist" are different answers, and a typo must not read as
   * reassurance.
   */
  async listSchedules(ref?: string): Promise<FleetScheduleView[]> {
    const project = ref ? await findProject(ref) : null;
    if (ref && !project) throw new Error(await noSuchProject(ref));
    const schedules = await store.listSchedules(project?.id);
    if (!schedules.length) return [];
    const runs = await store.listRuns().catch(() => [] as RunMeta[]);
    const now = new Date();
    const names = new Map((await store.listProjects()).map((p) => [p.id, p.name]));
    // One settings read and one spend count per project, not per schedule:
    // a project with six nightly schedules asks the same two questions six
    // times, and the answers cannot differ between them.
    const money = new Map<string, { monthSpendUsd: number; monthlyCapUsd: number }>();
    for (const projectId of new Set(schedules.map((s) => s.projectId))) {
      money.set(projectId, {
        monthSpendUsd: monthlyScheduledSpend(runs, projectId, now),
        monthlyCapUsd: (await effectiveSettings(projectId)).scheduledMonthlyCapUsd,
      });
    }
    return schedules.map((schedule) => ({
      projectName: names.get(schedule.projectId) ?? schedule.projectId,
      schedule,
      ...money.get(schedule.projectId)!,
    }));
  },

  async projectDetail(ref) {
    const project = await findProject(ref);
    if (!project) return noSuchProject(ref);
    const live = liveRunsOf(project.id)[0] ?? null;
    const lines = [`${project.name} — ${project.folder}`];
    if (live) {
      const m = live.meta;
      lines.push(`RUNNING "${runTitle(m)}" · ${spendLine(m)} · ${Math.round((Date.now() - m.createdAt) / 60_000)} min so far`);
      // A worktree project can have several going at once; the newest is
      // detailed below, but saying nothing about the others would read as
      // "one mission here" to whoever is asking.
      for (const other of liveRunsOf(project.id).slice(1)) {
        lines.push(`also running "${runTitle(other.meta)}" · ${spendLine(other.meta)} (${other.meta.id})`);
      }
      lines.push(await boxCount(m.folder));
      if (m.workers.length) {
        lines.push(`crew: ${m.workers.map((w) => `${w.id} ${w.status} (${clipText(firstLine(w.task), 60)})`).join('; ')}`);
      }
      const asks = live.pendingAsks();
      if (asks.length) {
        lines.push(`WAITING ON THE HUMAN (answered only through the card's buttons, never by you):`);
        for (const a of asks) lines.push(`  - ${a.kind}${a.toolName ? ` ${a.toolName}` : ''}: ${clipText(a.text, 200)}${a.options?.length ? ` [options: ${a.options.join(' / ')}]` : ''}`);
      }
      const words = await directorWords(m.id);
      if (words.last) lines.push(`director's latest words: ${clipText(words.last, 600)}`);
    } else {
      const last = await lastRunOf(project);
      lines.push(last
        ? `idle · last run "${runTitle(last)}" ${last.status}${last.endedAt ? ` at ${new Date(last.endedAt).toLocaleString()}` : ''} · ${spendLine(last)}`
        : 'idle · no runs yet');
      if (last && last.status !== 'done') {
        const words = await directorWords(last.id);
        if (words.error) lines.push(`it stopped with: ${clipText(words.error, 300)}`);
      }
    }
    const rec = projectRecord(runsOfProject(await store.listRuns().catch(() => [] as RunMeta[]), project));
    if (rec.done >= 2 && rec.medianCostUsd !== undefined) lines.push(`track record: ${rec.done} of ${rec.runs} missions finished; a finished one here costs about $${rec.medianCostUsd.toFixed(2)}${rec.medianMinutes !== undefined ? ` and takes ~${rec.medianMinutes} min` : ''}${rec.capHits ? `; ${rec.capHits} hit the cap` : ''}`);
    const meta = await store.readChatMeta(project.id).catch(() => null);
    if (meta?.proposal) lines.push(`a proposal is waiting for Start or Discard: "${clipText(firstLine(meta.proposal.mission), 100)}" cap $${meta.proposal.budgetUsd}`);
    if (chatTurns.has(project.id)) lines.push('its planner is replying right now');
    return lines.join('\n');
  },

  async runReport(ref) {
    const project = await findProject(ref);
    if (!project) return noSuchProject(ref);
    const last = await lastRunOf(project);
    if (!last) return `${project.name} has no finished run yet.`;
    const words = await directorWords(last.id);
    const lines = [
      `${project.name} · "${runTitle(last)}" · ${last.status}${last.endedAt ? ` at ${new Date(last.endedAt).toLocaleString()}` : ''} · ${spendLine(last)}`,
      await boxCount(last.folder),
    ];
    if (words.error) lines.push(`it stopped with: ${clipText(words.error, 400)}`);
    if (last.workers.length) lines.push(`crew: ${last.workers.map((w) => `${w.id} ${w.status}`).join(', ')}`);
    // Verdicts read out here and nowhere else on the phone: which reviewers
    // ran is a fact about the run, while which presets exist is configuration,
    // and configuration is edited on the dashboard.
    lines.push(...reviewReportLines(last.crew, last.reviews));
    if (words.result) lines.push(`director's closing report:\n${clipText(words.result, 2500)}`);
    else if (words.last) lines.push(`director's last words:\n${clipText(words.last, 2500)}`);
    return lines.join('\n');
  },

  async createProject(name) {
    const settings = await store.readSettings().catch(() => ({ global: {}, projects: {} }));
    const root = projectsRoot((settings.global as Record<string, unknown>).projectsRoot);
    const dir = slug(name);
    if (!dir) return 'That name leaves nothing to call a folder. Try letters and digits.';
    const existing = await findProject(dir);
    if (existing) return `${existing.name} is already linked at ${existing.folder}.`;
    const folder = path.join(root, dir);
    await mkdir(folder, { recursive: true });
    const project = await store.addProject(folder, name.trim());
    projectsCache.set(project.id, { name: project.name });
    return `Created ${project.name} at ${folder} and linked it. It is empty.`;
  },

  async linkProject(folderIn) {
    if (looksLikeRepoUrl(folderIn)) {
      const r = await cloneAndLink(folderIn.trim());
      if (r.error) return r.error;
      return `Cloned ${r.project!.name} into ${r.project!.folder} and linked it. Its planner can read it now (open_planning).`;
    }
    const folder = expandHome(folderIn.trim());
    if (!path.isAbsolute(folder)) return `A folder to link must be an absolute path (or ~/…), not "${folderIn}".`;
    const st = await stat(folder).catch(() => null);
    if (!st?.isDirectory()) return `${folder} is not a folder that exists. create_project makes a new one under the projects root.`;
    const all = await store.listProjects();
    const dup = all.find((p) => p.folder === folder);
    if (dup) return `${dup.name} is already linked at ${folder}.`;
    const project = await store.addProject(folder);
    projectsCache.set(project.id, { name: project.name });
    return `Linked ${project.name} at ${folder}.`;
  },

  async openPlanning(ref, message) {
    const project = await findProject(ref);
    if (!project) return noSuchProject(ref);
    if (activeByProject.has(project.id)) return `${project.name} has a mission running — planning waits for it to end. steer can pass the director a note now.`;
    if (chatTurns.has(project.id)) return `${project.name}'s planner is still replying to an earlier message.`;
    chatTurns.add(project.id);
    void driveChatTurn(project, message, message, 'telegram');
    return `Handed to ${project.name}'s planner; its reply follows. Plain messages now go to it. Tell the human that in one line and stop.`;
  },

  async proposeMission(ref, p) {
    const project = await findProject(ref);
    if (!project) return noSuchProject(ref);
    // Any live run, even in a project that could take another: a proposal is a
    // card the human comes back to, and proposing the next step while one is
    // still in flight is how two overlapping briefs get started by accident.
    if (activeByProject.has(project.id)) return `${project.name} has a mission running; propose the next step once it has ended.`;
    const meta = await chatMetaOf(project.id);
    const proposal: MissionProposal = { ...p, id: `mp-${Date.now().toString(36)}`, createdAt: Date.now() };
    await store.writeChatMeta({ ...meta, proposal, updatedAt: Date.now() });
    const emit = makeChatEmitter(project.id);
    emit('chat_message', { text: `(from the fleet planner) Proposed: ${firstLine(p.mission)}`, via: 'telegram' });
    emit('mission_proposed', { ...proposal, via: 'telegram' });
    return `Proposal card shown for ${project.name} (cap $${p.budgetUsd}${p.browser ? ', browser on' : ''}), on the phone and on the desk, with Start and Discard. Say in one line what you proposed; do not repeat the brief.`;
  },

  async steer(ref, note) {
    const project = await findProject(ref);
    if (!project) return noSuchProject(ref);
    const live = liveRunsOf(project.id);
    const run = live[0];
    if (!run) return `${project.name} has no mission running, so there is no director to steer.`;
    // Several missions can be live in one project, and a note has to land on
    // one of them: the newest, said out loud so nobody assumes it reached the
    // other. Steering a particular run by id is POST /steer's job.
    const which = live.length > 1 ? ` (its newest mission, ${run.meta.id}; ${live.length - 1} other${live.length > 2 ? 's are' : ' is'} also running)` : '';
    return run.steer(note) ? `Note passed to ${project.name}'s director${which}; it reads it at its next turn.` : `${project.name}'s director is no longer accepting notes (the run is ending).`;
  },
};

/**
 * One turn at the front desk. `via` says who asked: the phone hears the
 * answer, an HTTP caller gets it back. Same session either way.
 */
async function driveFleetTurn(text: string, via: 'telegram' | 'http'): Promise<{ text: string; costUsd: number; handedOff?: string; error?: string; busy?: boolean }> {
  if (fleetAbort) return { text: '', costUsd: 0, busy: true };
  const emit = makeChatEmitter(FLEET_CHAT_ID);
  const meta = await chatMetaOf(FLEET_CHAT_ID);
  const g = (await store.readSettings().catch(() => ({ global: {}, projects: {} }))).global as Record<string, unknown>;
  const model = modelChoice(g.fleetPlannerModel ?? g.plannerModel) || DEFAULT_FLEET_MODEL;
  const abort = new AbortController();
  fleetAbort = abort;
  emit('chat_message', { text, via });
  const stopBusy = via === 'telegram' ? notifyHub.busy() : () => {};
  try {
    const resolved = await resolveProvider(providerOf({}), store.root);
    emit('chat_turn', { state: 'thinking', model, provider: resolved.label, costBasis: resolved.costBasis });
    const problem = providerProblem(resolved) ?? await signedInProblem(resolved);
    if (problem) {
      emit('chat_error', { error: `provider unavailable — ${problem}` });
      return { text: '', costUsd: 0, error: `provider unavailable — ${problem}` };
    }
    const cwd = projectsRoot(g.projectsRoot);
    await mkdir(cwd, { recursive: true }).catch(() => {});
    const { models } = await availableModels(null).catch(() => ({ models: [] }));
    // The first turn ever looks back two hours; every later one looks back
    // to the end of the previous turn.
    const since = meta.sessionId ? meta.updatedAt : Date.now() - 2 * 3_600_000;
    const result = await runFleetTurn({
      sessionId: meta.sessionId, text, model, cwd, host: fleetHost, via,
      news: fleetNews(since), sinceMs: Date.now() - since,
      models: models.map((m) => ({ id: m.id, label: m.label, providerId: m.providerId, providerLabel: m.providerLabel, costBasis: m.costBasis, note: m.note, record: m.record })),
      agentEnv: await agentEnvFor(resolved, `chat:${FLEET_CHAT_ID}`),
      emit, abort,
    });
    const next: ChatMeta = { ...meta, sessionId: result.sessionId ?? meta.sessionId, costUsd: meta.costUsd + result.costUsd, updatedAt: Date.now() };
    await store.writeChatMeta(next);
    emit('chat_cost', { costUsd: next.costUsd, turnUsd: result.costUsd });
    if (result.stopped) emit('chat_error', { error: 'Stopped — the rest of this reply was discarded.' });
    else if (result.error) emit('chat_error', { error: result.error });
    if (via === 'telegram') {
      if (result.error) void notifyHub.say(`The fleet planner hit an error: ${escTg(result.error)}`);
      else if (result.said) void notifyHub.say(escTg(result.said.slice(0, 3500)));
    }
    return { text: result.said, costUsd: result.costUsd, handedOff: result.handedOff, error: result.error };
  } catch (err) {
    console.error('fleet planning turn failed:', err);
    emit('chat_error', { error: String(err) });
    return { text: '', costUsd: 0, error: String(err) };
  } finally {
    stopBusy();
    if (fleetAbort === abort) fleetAbort = null;
    emit('chat_turn', { state: 'idle' });
  }
}

/** Plain text from the phone: the project planner you were just in, else the front desk. */
async function routePhoneTalk(text: string): Promise<void> {
  const say = (t: string) => void notifyHub.say(t);
  const last = lastPhonePlanning ? { projectId: lastPhonePlanning, at: lastPhonePlanningAt } : null;
  if (phoneRoute(last, Date.now(), PHONE_CONTEXT_MS) === 'project' && last) {
    const project = await store.getProject(last.projectId);
    if (project && !activeByProject.has(project.id)) {
      if (chatTurns.has(project.id)) return say('The planner is still replying — wait, or /stop.');
      chatTurns.add(project.id);
      void driveChatTurn(project, text, text, 'telegram');
      return;
    }
  }
  const r = await driveFleetTurn(text, 'telegram');
  if (r.busy) say('The fleet planner is still replying — wait, or /stop.');
}

/**
 * Text from the linked chat. In order: a command; an answer to an open ask
 * (the hub's job); a continuation of the last planning conversation the
 * phone started; else the fleet planner — never silence.
 */
async function handlePhoneText(text: string, replyTo?: string): Promise<void> {
  const say = (t: string) => void notifyHub.say(t);
  const cmd = parseCommand(text);
  if (cmd) {
    try {
      switch (cmd.cmd) {
        case 'help': return say(HELP_TEXT);
        case 'fleet': {
          // Back to the front desk, with or without something to say. The
          // project context is dropped either way: that is what the command
          // is for.
          lastPhonePlanning = null;
          lastPhonePlanningAt = 0;
          if (!cmd.text) return say('Front desk. Ask me anything about the fleet, or say what you want started where.');
          const r = await driveFleetTurn(cmd.text, 'telegram');
          if (r.busy) say('The fleet planner is still replying — wait, or /stop.');
          return;
        }
        case 'projects': {
          const all = await store.listProjects();
          if (!all.length) return say('No projects linked yet. /new &lt;name&gt; creates one.');
          const runs = await store.listRuns();
          const lines = all.map((p) => {
            const live = liveCountOf(p.id);
            const last = runsOfProject(runs, p).sort((a, b) => b.createdAt - a.createdAt)[0];
            return `• <b>${escTg(p.name)}</b> — ${live > 1 ? `${live} missions running` : live ? 'running' : last ? `last run ${last.status}` : 'no runs yet'}`;
          });
          return say(`<b>Fleet</b>\n${lines.join('\n')}`);
        }
        case 'status': {
          const live = activeRuns();
          // Planners count as activity too: "all quiet" while one is drafting
          // a proposal for you read as a lie the first time it happened.
          const planning: string[] = [];
          for (const id of chatTurns) {
            const name = projectsCache.get(id)?.name ?? (await store.getProject(id))?.name ?? id;
            planning.push(`• <b>${escTg(name)}</b> — the planner is replying`);
          }
          for (const id of await store.listChatIds()) {
            if (chatTurns.has(id)) continue;
            const m = await store.readChatMeta(id).catch(() => null);
            if (!m?.proposal) continue;
            // A conversation left behind by an unlinked project is not planning.
            const name = projectsCache.get(id)?.name ?? (await store.getProject(id))?.name;
            if (name) planning.push(`• <b>${escTg(name)}</b> — a proposal is waiting for Start or Discard`);
          }
          if (!live.length && !planning.length) return say('All quiet — nothing running, nothing waiting on you.');
          if (!live.length) return say(`<b>Planning</b>\n${planning.join('\n')}`);
          const lines = live.map((r) => {
            const name = projectsCache.get(r.meta.projectId ?? '')?.name ?? r.meta.folder;
            const spend = r.meta.costBasis === 'priced' ? `$${r.meta.costUsd.toFixed(2)} of $${r.meta.budgetUsd}` : 'unpriced';
            const asks = r.pendingAsks().length;
            return `• <b>${escTg(name)}</b> — ${escTg(r.meta.title || r.meta.mission.split('\n')[0].slice(0, 80))}\n  ${spend}${asks ? ` · <b>${asks} waiting on you</b>` : ''}`;
          });
          return say(`<b>Running · ${live.length}</b>\n${lines.join('\n')}${planning.length ? `\n\n<b>Planning</b>\n${planning.join('\n')}` : ''}`);
        }
        case 'new': {
          if (looksLikeRepoUrl(cmd.name)) {
            say(`Cloning <code>${escTg(cmd.name.trim())}</code>…`);
            const r = await cloneAndLink(cmd.name.trim());
            if (r.error) return say(`Could not clone: ${escTg(r.error)}`);
            lastPhonePlanning = r.project!.id; lastPhonePlanningAt = Date.now();
            return say(`Cloned <b>${escTg(r.project!.name)}</b> into <code>${escTg(r.project!.folder)}</code> and linked it.\nTell me what it should do next — just type it.`);
          }
          const settings = await store.readSettings().catch(() => ({ global: {}, projects: {} }));
          const root = projectsRoot((settings.global as Record<string, unknown>).projectsRoot);
          const name = slug(cmd.name);
          if (!name) return say('That name leaves nothing to call a folder. Try letters and digits.');
          const folder = path.join(root, name);
          if (await findProject(name)) return say(`<b>${escTg(name)}</b> is already linked. /plan ${escTg(name)} &lt;what you want&gt;`);
          await mkdir(folder, { recursive: true });
          const project = await store.addProject(folder, cmd.name.trim());
          projectsCache.set(project.id, { name: project.name });
          lastPhonePlanning = project.id;
          return say(`Created <b>${escTg(project.name)}</b> at <code>${escTg(folder)}</code> and linked it.\nNow tell me what it should do — just type it, or /plan ${escTg(name)} &lt;what you want&gt;.`);
        }
        case 'plan': case 'run': {
          const project = await findProject(cmd.project);
          if (!project) return say(`No project called <b>${escTg(cmd.project)}</b>. /projects lists them; /new creates one.`);
          // Planning waits for the folder to be quiet whatever the isolation —
          // the planner reads the tree a mission is changing. /run does not:
          // whether another mission may start is the reservation's answer,
          // below, and in a worktree project it can be yes.
          if (cmd.cmd === 'plan' && activeByProject.has(project.id)) {
            return say(`<b>${escTg(project.name)}</b> has a mission running — /status shows it.`);
          }
          if (cmd.cmd === 'plan') {
            if (chatTurns.has(project.id)) return say('The planner is still replying — /stop ends that.');
            chatTurns.add(project.id);
            void driveChatTurn(project, cmd.text, cmd.text, 'telegram');
            return;
          }
          // /run: skip the talk. The project's default cap bounds it; the
          // browser is off unless the brief says otherwise, like the composer.
          const iso = await isolationFor(project);
          const reserved = reserveProject(project.id, { ...iso, projectName: project.name });
          if ('error' in reserved) return say(`${escTg(reserved.error)}.`);
          dispatch(project.id, reserved.ticket, startRun(project.id, reserved.ticket, iso.isolation, project.folder, cmd.text, project.defaultBudgetUsd,
            modelChoice(undefined), modelChoice(undefined), /screenshot|browser|render|console/i.test(cmd.text),
            providerOf(project), {}, { startedBy: 'phone' }));
          return say(`Started a mission on <b>${escTg(project.name)}</b> with a $${project.defaultBudgetUsd} cap. I will tell you when it needs you or ends.`);
        }
        case 'schedules': {
          // Reading only. A schedule is standing configuration — it decides
          // what a machine does while nobody is watching — and remote surfaces
          // never grant standing changes, so there is no create, edit, pause,
          // resume or run-now here. The reply says so rather than leaving
          // someone to discover it by trying.
          const project = cmd.project ? await findProject(cmd.project) : null;
          if (cmd.project && !project) return say(`No project called <b>${escTg(cmd.project)}</b>. /projects lists them.`);
          const schedules = await store.listSchedules(project?.id);
          const footer = 'Schedules are read-only from here — create, edit, pause and resume live in the dashboard.';
          if (!schedules.length) {
            return say(`No schedules${project ? ` on <b>${escTg(project.name)}</b>` : ''} yet.\n${footer}`);
          }
          const names = new Map((await store.listProjects()).map((p) => [p.id, p.name]));
          const lines = schedules.map((s) => {
            const state = s.pausedReason
              ? `paused (${s.pausedReason === 'monthly-cap' ? 'monthly cap' : s.pausedReason})`
              : s.enabled ? 'enabled' : 'disabled';
            const next = s.pausedReason || !s.enabled || s.nextRunAt === null
              ? 'no next run'
              : `next ${relativeTime(s.nextRunAt - Date.now())}`;
            const where = project ? '' : ` · ${escTg(names.get(s.projectId) ?? s.projectId)}`;
            return `• <b>${escTg(s.name)}</b>${where}\n  ${escTg(describeCadence(s.cadence))} · ${next} · ${state}`;
          });
          return say(`<b>Schedules${project ? ` · ${escTg(project.name)}` : ''}</b>\n${lines.join('\n')}\n\n${footer}`);
        }
        case 'stop': {
          const project = cmd.project ? await findProject(cmd.project) : (lastPhonePlanning ? await store.getProject(lastPhonePlanning) : null);
          const abort = project && chatAborts.get(project.id);
          if (project && abort) {
            dropPendingAsk(project.id);
            abort.abort();
            return say(`Stopped the planner on <b>${escTg(project.name)}</b>.`);
          }
          if (fleetAbort) { fleetAbort.abort(); return say('Stopped the fleet planner.'); }
          return say('No planner reply is in flight.');
        }
      }
    } catch (err) {
      return say(`That failed: ${escTg(err instanceof Error ? err.message : String(err))}`);
    }
  }
  if (notifyHub.handleText(text, replyTo)) return;
  await routePhoneTalk(text);
}

/** One linking attempt at a time; a new code cancels the previous wait. */
let telegramLink: { code: string; abort(): void; startedAt: number } | null = null;

async function patchGlobalSettings(patch: Record<string, unknown>): Promise<void> {
  const all = await store.readSettings().catch(() => ({ global: {}, projects: {} }));
  const global = { ...(all.global as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete global[k]; else global[k] = v;
  }
  await store.writeSettings({ ...all, global });
  notifyCtxCache = null;
  forgetIsolation();
}

/** Reads a project's chat meta, or the empty shape for one never started. */
async function chatMetaOf(projectId: string): Promise<ChatMeta> {
  const now = Date.now();
  return (await store.readChatMeta(projectId).catch(() => null))
    ?? { projectId, costUsd: 0, createdAt: now, updatedAt: now };
}

/**
 * `shown` is what the transcript records as the human's message when it
 * differs from what the planner is sent (a fork's seed). `via: 'telegram'`
 * means the phone started this turn: the planner's words go back there, and
 * a proposal it makes gets a card with Start / Discard.
 */
async function driveChatTurn(project: Project, text: string, shown: string = text, via?: 'telegram'): Promise<void> {
  const raw = makeChatEmitter(project.id);
  let said = '';
  let asked = false;
  const emit = via !== 'telegram' ? raw : (event: string, data: unknown) => {
    if (event === 'message') {
      const m = (data as { msg?: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } } }).msg;
      if (m?.type === 'assistant') {
        for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text?.trim()) said = b.text.trim();
      }
    }
    if (event === 'chat_question') asked = true;
    if (event === 'mission_proposed') { asked = true; data = { ...(data as object), via }; }
    raw(event, data);
  };
  if (via === 'telegram') { lastPhonePlanning = project.id; lastPhonePlanningAt = Date.now(); }
  const meta = await chatMetaOf(project.id);
  emit('chat_message', { text: shown, ...(via ? { via } : {}) });
  const stopBusy = via === 'telegram' ? notifyHub.busy() : () => {};
  try {
    const settings = await effectiveSettings(project.id);
    const resolved = await resolveProvider(providerOf(project), store.root);
    // Who is answering, said on every turn. A planning conversation had no
    // visible model or provider at all — the human was talking to "foreman"
    // and could not tell whether that meant Sonnet on their subscription or a
    // local model through a gateway, which decides both the quality of the
    // advice and who is paying for it.
    emit('chat_turn', {
      state: 'thinking',
      model: settings.plannerModel || DEFAULT_PLANNER_MODEL,
      provider: resolved.label,
      costBasis: resolved.costBasis,
    });
    const problem = providerProblem(resolved) ?? await signedInProblem(resolved);
    if (problem) {
      emit('chat_error', { error: `provider unavailable — ${problem}` });
      return;
    }
    // What the machine can run, so a recommendation is a real id. Fetched
    // per turn because it is per turn: a provider that came up or went away
    // since the last message changes the answer.
    const { models } = await availableModels(project).catch(() => ({ models: [] }));
    const abort = new AbortController();
    chatAborts.set(project.id, abort);
    const result = await runPlanningTurn({
      projectId: project.id,
      models: models.map((m) => ({
        id: m.id, label: m.label, providerId: m.providerId,
        providerLabel: m.providerLabel, costBasis: m.costBasis, note: m.note, record: m.record,
      })),
      anchor: await budgetAnchorFor(project).catch(() => ''),
      sessionId: meta.sessionId,
      folder: project.folder,
      text,
      model: settings.plannerModel,
      agentEnv: await agentEnvFor(resolved, `chat:${project.id}`),
      emit,
      abort,
    });
    const next: ChatMeta = {
      ...meta,
      sessionId: result.sessionId ?? meta.sessionId,
      costUsd: meta.costUsd + result.costUsd,
      updatedAt: Date.now(),
      // A fresh proposal replaces an older unused one: the conversation moved
      // on, and offering the human two drafts of the same mission is worse
      // than offering the current one.
      proposal: result.proposal ?? meta.proposal,
    };
    await store.writeChatMeta(next);
    emit('chat_cost', { costUsd: next.costUsd, turnUsd: result.costUsd });
    if (result.stopped) emit('chat_error', { error: 'Stopped — the rest of this reply was discarded.' });
    else if (result.error) emit('chat_error', { error: result.error });
    // The phone hears the planner's last words unless a card (question or
    // proposal) already said them; a bare "done" would be noise.
    if (via === 'telegram') {
      if (result.error) void notifyHub.say(`<b>${escTg(project.name)}</b> · the planner hit an error: ${escTg(result.error)}`);
      else if (!asked && said) void notifyHub.say(`<b>${escTg(project.name)}</b>\n${escTg(said.slice(0, 3500))}`);
    }
  } catch (err) {
    // runPlanningTurn does not throw; anything here is a Foreman bug or a
    // storage failure, and must not take the server down with it.
    console.error(`planning turn failed for project ${project.id}:`, err);
    emit('chat_error', { error: String(err) });
  } finally {
    stopBusy();
    chatTurns.delete(project.id);
    chatAborts.delete(project.id);
    emit('chat_turn', { state: 'idle' });
    // The reply is the latest word in the conversation, so the phone's
    // context window counts from it, not from the message that started it.
    if (via === 'telegram' && lastPhonePlanning === project.id) lastPhonePlanningAt = Date.now();
  }
}

/**
 * A mission has started, so the conversation that led to it is finished.
 *
 * The handoff is recorded first — the chat is the story of how this mission
 * came to exist, and it should not simply stop at the moment the work began —
 * and then the whole conversation is archived, not left as the project's
 * front page. A project visited after a mission shows its runs and a blank
 * line, not a spent planning session scrolled to the bottom; the run is the
 * continuation, and "Plan the next step" forks a new conversation from it.
 * Open tabs are told, so they reset without a reload.
 */
async function consumeProposal(projectId: string, runId: string, mission: string): Promise<void> {
  const meta = await store.readChatMeta(projectId).catch(() => null);
  if (!meta) return;
  const handoff = { runId, mission };
  await store.appendChat(projectId, { ts: Date.now(), event: 'mission_started', data: handoff }).catch(() => {});
  noteFleetEvent(projectId, 'mission_started', handoff);
  notifyHub.handle({ event: 'mission_started', runId: null, projectId, chat: true, data: handoff, ts: Date.now() });
  await store.archiveChat(projectId, runId).catch(() => {});
  broadcastChat(projectId, 'chat_cleared', {});
}

/**
 * Reserves a slot in a project for a new/resumed mission. Synchronous
 * check-and-set: routes call this AFTER their last await and BEFORE any
 * further await, which makes the project's concurrency limit race-free on the
 * single JS thread. The isolation and the configured limit are read before and
 * handed in for exactly that reason — nothing in here may wait.
 *
 * The answer is either a ticket, to be carried to driveRun so the slot is
 * released once and for the right run, or the sentence to tell the caller.
 * `reservationDecision` in src/isolation.ts owns both the limit and the
 * wording; a shared project still says what it always said.
 *
 * The ticket is a run id from the same generator the runs use: the caller has
 * to thread it through anyway, and an id is far easier to find in a log than a
 * counter when a release goes missing. It is not the run's own id — the run
 * does not exist yet.
 */
function reserveProject(
  projectId: string,
  opts: {
    isolation: Isolation; configured?: unknown; projectName?: string;
    /**
     * Where this mission will work. A new run's answer is the isolation the
     * reservation is being granted under; a RESUME's is its own record — a run
     * from before the project was flipped to 'worktree' has none, and works in
     * the project folder however the project is configured today.
     */
    workspace?: Isolation;
  },
): { ticket: string } | { error: string; limit: number } {
  const workspace = opts.workspace ?? opts.isolation;
  const decision = reservationDecision({
    live: liveCountOf(projectId),
    isolation: opts.isolation,
    configured: opts.configured,
    projectName: opts.projectName,
    workspace,
    sharedLive: sharedLiveOf(projectId),
  });
  if (!decision.ok) return { error: decision.reason, limit: decision.limit };
  const ticket = newRunId();
  const slots = activeByProject.get(projectId) ?? new Map<string, MissionRun | null>();
  slots.set(ticket, null); // reservation placeholder
  activeByProject.set(projectId, slots);
  reservedWorkspaces.set(ticket, workspace);
  return { ticket };
}

/**
 * Where an exposed service is reachable from, without the trailing slash — the
 * same address the human already uses for Foreman, but on SERVICES_PORT.
 *
 * The starting point is the URL the dashboard hands out (Settings, else the
 * tailnet, else localhost), because that is the one that actually reaches this
 * machine from wherever the human reads their notifications. Only the port
 * changes. An https URL cannot simply be re-pointed: it is `tailscale serve`
 * terminating TLS in front of the main port, and serve fronts that port alone,
 * so the honest answer is plain http straight at the tailnet address.
 */
async function servicesBase(): Promise<string> {
  const publicUrl = (await notifySettings().catch(() => null))?.publicUrl
    ?? (tailnet ? tailnetUrl(tailnet, PORT) : `http://localhost:${PORT}`);
  const direct = () => `http://${tailnet ? (tailnet.dnsName ?? tailnet.ip) : 'localhost'}:${SERVICES_PORT}`;
  let u: URL;
  try { u = new URL(publicUrl); } catch { return direct(); }
  if (u.protocol !== 'http:') return direct();
  u.port = String(SERVICES_PORT);
  return u.origin;
}

/**
 * Runs a mission to completion. The project must already be reserved, and
 * `ticket` is that reservation: every exit from here releases it, so the slot
 * goes back exactly once and only this run's own.
 */
async function driveRun(
  projectId: string, ticket: string, meta: RunMeta, resume?: { sessionId?: string },
  changes?: { directorChanged: boolean; workerChanged: boolean },
): Promise<void> {
  const emit = makeEmitter(meta.id, projectId);
  // Registered before anything can fail, so even a run that dies on its
  // provider still tells the emitter which schedule it belonged to.
  drivingRuns.set(meta.id, meta);
  // One resolution per run, from the provider frozen into the run's metadata.
  // A run that cannot resolve a credential must not start: dispatching anyway
  // would fall back to whatever the environment happens to hold.
  const resolved = await resolveProvider(providerOf(meta), store.root);
  const problem = providerProblem(resolved) ?? await signedInProblem(resolved);
  if (problem) {
    meta.status = 'error';
    meta.endedAt = Date.now();
    await store.writeMeta(meta).catch(() => {});
    emit('run_error', { error: `provider unavailable — ${problem}` });
    emit('run_finished', { status: 'error', costUsd: meta.costUsd });
    drivingRuns.delete(meta.id);
    releaseRepoHold(meta.id);
    releaseProject(projectId, ticket);
    return;
  }
  // Each role's provider, checked against its model before anything is
  // resolved. Model and provider are picked together but stored apart, and
  // a stale pair — `fable` pinned to Codex by an older settings file — fails
  // on the first turn with an upstream 400 nobody chose. The model list is
  // the authority; a corrected role is written back and said in the
  // transcript, so the run reads the way it actually ran.
  {
    const project = await store.getProject(projectId).catch(() => null);
    const { models } = await availableModels(project).catch(() => ({ models: [] as ModelOption[] }));
    const known = models.map((m) => ({ id: m.id, providerId: m.providerId }));
    const director = reconcileRole('director', meta.directorModel, meta.directorProviderId, known);
    const worker = reconcileRole('workers', meta.workerModel, meta.workerProviderId, known);
    const notes = [director.note, worker.note].filter((n): n is string => Boolean(n));
    if (notes.length) {
      meta.directorProviderId = director.providerId;
      meta.workerProviderId = worker.providerId;
      await store.writeMeta(meta).catch(() => {});
      emit('models_changed', {
        text: `Provider corrected before dispatch — ${notes.join(' ')}`,
        directorModel: meta.directorModel, workerModel: meta.workerModel,
      });
    }
  }
  let agentEnv;
  let roleBasis = resolved.costBasis;
  let prices: { director?: ModelPrice; worker?: ModelPrice } = {};
  let roleBases: { director: CostBasis; worker: CostBasis; crew?: Record<string, { basis: CostBasis; native: boolean }> } | undefined;
  let gatewayRoles: { director: boolean; worker: boolean; crew?: boolean } = { director: false, worker: false };
  try {
    // Resolved per role. Where both roles share a provider this resolves once
    // and starts one gateway; where they differ, the supervisor already runs a
    // process per provider.
    const directorBase = meta.directorProviderId
      ? await resolveProvider(providerForRole(meta, meta.directorProviderId), store.root)
      : resolved;
    const workerBase = meta.workerProviderId === meta.directorProviderId
      ? directorBase
      : await resolveProvider(providerForRole(meta, meta.workerProviderId), store.root);
    // Each role's provider carries the model that role will run, so the
    // SDK's aliases (haiku/sonnet/opus) resolve to something its gateway
    // actually serves. Without this, the one call that still used an alias
    // — the run title, on haiku — went upstream as a literal claude-* id and
    // 404'd four times on a kimi gateway while the mission itself ran fine.
    // Two roles on one provider with different models become two objects;
    // they still share a gateway, since the gateway is keyed by upstream.
    const directorProvider = withRoleModel(directorBase, meta.directorModel);
    const workerProvider = withRoleModel(workerBase, meta.workerModel);
    for (const p of new Set([directorProvider, workerProvider])) {
      const roleProblem = providerProblem(p);
      if (roleProblem) throw new Error(roleProblem);
    }
    const key = ledgerKeyFor(meta);
    agentEnv = {
      director: await agentEnvFor(directorProvider, meta.id, key),
      worker: directorProvider === workerProvider
        ? await agentEnvFor(directorProvider, meta.id, key)
        : await agentEnvFor(workerProvider, meta.id, key),
      crew: await crewEnvsFor(meta, key),
    };
    // Only roles that actually go through a gateway are counted there; a
    // native role's tokens arrive on the SDK's own result message, and adding
    // both would double every one of them.
    gatewayRoles = {
      // A crew preset on a gateway sends its tokens to the same ledger, so
      // polling has to run even when both ordinary roles are native.
      crew: Object.values(await crewBasesFor(meta) ?? {}).some((c) => !c.native),
      director: directorProvider.wire !== 'anthropic-native',
      worker: workerProvider.wire !== 'anthropic-native',
    };
    const directorCost = await roleCost(directorProvider, meta.directorModel);
    const workerCost = directorProvider === workerProvider && meta.directorModel === meta.workerModel
      ? directorCost
      : await roleCost(workerProvider, meta.workerModel);
    roleBasis = combineBasis(directorCost.basis, workerCost.basis);
    prices = { director: directorCost.price, worker: workerCost.price };
    roleBases = { director: directorCost.basis, worker: workerCost.basis, crew: await crewBasesFor(meta) };
  } catch (err) {
    meta.status = 'error';
    meta.endedAt = Date.now();
    await store.writeMeta(meta).catch(() => {});
    emit('run_error', { error: String(err instanceof Error ? err.message : err) });
    emit('run_finished', { status: 'error', costUsd: meta.costUsd });
    drivingRuns.delete(meta.id);
    releaseRepoHold(meta.id);
    releaseProject(projectId, ticket);
    return;
  }
  // Frozen with the provider: whether this run's dollar figure is real money
  // decides which caps bind, and that must not change under a resume.
  //
  // Decided by the ROLES, not the project's own provider. A run whose director
  // is on Codex and whose workers are on Ollama spends no real dollars, even
  // though the project is nominally a Claude Code one — reading the basis
  // off the project would show that run a dollar meter and arm a dollar cap
  // over spend that never happens. See combineBasis() for how two roles fold
  // into one answer.
  //
  // Recomputed on every dispatch, including a resume, rather than frozen once.
  // The inputs are already frozen — the role providers live in this run's own
  // metadata — so this is deterministic and cannot drift with settings. What
  // it does allow is a run whose flag was computed by older, wrong code to
  // heal when it is resumed, instead of being permanently stuck against a cap
  // it should never have had.
  meta.costBasis = roleBasis;
  // Written in step so a run started here still reads correctly if it is ever
  // handled by a build from before the split.
  meta.metered = roleBasis === 'priced';
  const run = new MissionRun(meta, emit, (m) => void store.writeMeta(m), agentEnv, prices, {
    key: ledgerKeyFor(meta), roles: gatewayRoles, read: gatewayUsage,
  }, roleBases, {
    // A dev server behind Foreman's address. Declared ports only, and only
    // ones something is listening on — an agent cannot reserve a path for a
    // server it has not started.
    // Detected per dispatch, so a browser installed from the setup page
    // serves the very next mission without a restart.
    browserChannel: (await detectBrowser())?.channel,
    exposeService: async (runId, port, label) => {
      if (servicesDown) return { ok: false, reason: servicesDown };
      if (!(await portOpen(port))) return { ok: false, reason: `nothing is listening on 127.0.0.1:${port} — start the server first` };
      // Whoever holds the port right now is what the crew just started, and
      // the only process a later stop is allowed to touch.
      const pid = await listeningPid(port);
      const svc = services.register(runId, port, label, pid ?? undefined);
      return { ok: true, url: `${await servicesBase()}${svc.path}`, path: svc.path, pid: pid ?? undefined };
    },
  });
  attachRun(projectId, ticket, run);
  try {
    if (changes?.directorChanged || changes?.workerChanged) {
      const parts = [
        changes.directorChanged ? `director → ${meta.directorModel}` : null,
        changes.workerChanged ? `workers → ${meta.workerModel}` : null,
      ].filter(Boolean).join(', ');
      emit('models_changed', {
        text: `Models updated from Settings before resume: ${parts}.` +
          (changes.directorChanged
            ? ' The director starts a fresh session (a model cannot change mid-session);' +
              ' it recovers state from .foreman/MISSION.md.'
            : ''),
        directorModel: meta.directorModel, workerModel: meta.workerModel,
      });
    }
    await run.start(resume);
  } catch (err) {
    // start() catches mission errors itself; anything reaching here is a
    // Foreman bug or storage failure. Never let it become an unhandled
    // rejection that takes the whole server (and other missions) down.
    console.error(`run ${meta.id} failed outside the mission loop:`, err);
    meta.status = 'error';
    meta.endedAt = Date.now();
    await store.writeMeta(meta).catch(() => {});
  } finally {
    // However the run ended, it no longer needs its gateways.
    releaseGateways(meta.id);
    drivingRuns.delete(meta.id);
    try {
      // Freeze the record: the mission doc and the deck as they stand at this
      // moment, beside the run's meta and log. Done first, before the branch
      // closes, so the record is what the crew left — a later mission in the
      // same folder rewrites MISSION.md and the live diff, never this copy.
      const frozen = await snapshotRun(store.runDirectory(meta.id), meta.folder, meta.id);
      if (frozen.doc || frozen.deck) {
        meta.snapshotAt = Date.now();
        await store.writeMeta(meta).catch(() => {});
      }
      // A finished mission on its own branch closes with a commit of whatever
      // the crew left uncommitted. Done only: an interrupted run resumes on
      // the same branch and its tree, and an error is not a result to record.
      if (meta.git && meta.status === 'done') {
        const label = meta.title || meta.mission.split('\n').find((l) => l.trim())?.trim().slice(0, 72) || meta.id;
        const closed = await closeMissionBranch(meta.folder, meta.git, `foreman: ${label}`);
        meta.git = { branch: closed.branch, base: closed.base, baseHead: closed.baseHead, commits: closed.commits, commit: closed.commit ?? meta.git.commit };
        await store.writeMeta(meta).catch(() => {});
        gitInfoCache.delete(meta.folder);
        const ahead = closed.commits ?? 0;
        emit('git_committed', {
          branch: closed.branch, base: closed.base, commits: ahead, commit: closed.commit, committed: closed.committed, error: closed.error,
          text: closed.error
            ? `Could not commit the mission's work on ${closed.branch}: ${closed.error}`
            : `${closed.committed ? `Committed the mission's work as ${closed.commit}` : 'Nothing left to commit'} — ${closed.branch} is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${closed.base}. Merge or open a pull request when you are ready; Foreman does neither.`,
        });
      }
      // What becomes of the worktree. Only a run that FINISHED and left no commit
      // is cleaned up: an empty checkout is nothing but clutter, and the branch
      // closing above has already committed anything the crew left, so "no
      // commits" here really does mean the mission produced no code.
      //
      // An interrupted or failed run always keeps its worktree, whatever it
      // contains — a resume needs that exact checkout, and resumeWorktree()
      // refuses to resume without it rather than falling back to the project
      // folder. That is why this reads `status === 'done'` and not "ended with no
      // commits": the empty-and-interrupted run is the one case where removing
      // the directory would take the resume with it.
      if (meta.worktree && !meta.worktree.removedAt) {
        const wt = meta.worktree;
        const branch = meta.git?.branch ?? 'its branch';
        if (meta.status === 'done' && !meta.git?.commits) {
          const failed = await removeMissionWorktree(wt.repo, wt.path);
          if (failed) {
            emit('git_note', { text: `Could not remove this mission's empty worktree at ${wt.path}: ${failed}. It is safe to delete by hand.` });
          } else {
            wt.removedAt = Date.now();
            await store.writeMeta(meta).catch(() => {});
            gitInfoCache.delete(wt.path);
            emit('git_note', { text: `Removed this mission's worktree at ${wt.path}: it ended with no commits, so there was nothing in it to keep.` });
          }
        } else if (meta.status === 'done') {
          emit('git_note', {
            text: `This mission's work is still in its worktree at ${wt.path}, on ${branch}. `
              + 'Merge or open a pull request from there when you are ready; the run page can remove the worktree once you have.',
          });
        } else {
          emit('git_note', {
            text: `Kept this mission's worktree at ${wt.path} so it can be resumed there — a resume needs that exact checkout and will not fall back to ${wt.repo}.`,
          });
        }
      }
    } finally {
      // The reservation is given back last, not first: the closing commit
      // above works in the mission's own checkout, and in a shared project the
      // next mission would `checkout -b` in that same tree the moment the slot
      // opens. A throw anywhere above must still release it, hence the finally.
      //
      // The parent repository goes back here too, and for the same reason it
      // was claimed: it is held for the life of the RUN, so the run ending is
      // exactly when the next mission in that repository may have it.
      releaseRepoHold(meta.id);
      releaseProject(projectId, ticket);
    }
  }
}

/** Effective run configuration: defaults ← global Settings ← project overlay. */
async function effectiveSettings(projectId: string): Promise<{
  toolPolicy: ToolPolicy; autoAllowReadOnly: boolean;
  directorModel: ModelChoice; workerModel: ModelChoice; plannerModel: ModelChoice;
  /** Provider serving each role, when Settings pinned one with the model. */
  directorProviderId?: string; workerProviderId?: string;
  /** In a repository, each mission runs on a branch of its own (default on). */
  gitBranchPerMission: boolean;
  /** A mission in a worktree may use its parent repository without asking (default on). */
  allowWorktreeParent: boolean;
  /** Whether missions here run in the project folder or each in a worktree of its own. */
  isolation: Isolation;
  /**
   * How many missions may run at once, as configured — raw, because
   * concurrencyLimit() is the one place that clamps it and pins a shared
   * project at 1 whatever this says.
   */
  maxConcurrentMissions: unknown;
  /** Percent of the cap at which the director is told to start verifying (default 80). */
  budgetWarnAt: number;
  /** Ceiling on what this project's SCHEDULED runs may cost in one calendar month. */
  scheduledMonthlyCapUsd: number;
  /** The crew presets a mission here may be started with (built-ins until edited). */
  crewPresets: CrewPreset[];
}> {
  const s = await store.readSettings()
    .catch(() => ({ global: {}, projects: {} as Record<string, object> }));
  const g = s.global as Record<string, unknown>;
  const p = (s.projects as Record<string, unknown>)[projectId] as Record<string, unknown> ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return {
    toolPolicy: {
      ...DEFAULT_TOOL_POLICY,
      ...(g.toolPolicy as ToolPolicy | undefined),
      ...(p.toolPolicy as ToolPolicy | undefined),
    },
    autoAllowReadOnly:
      (p.autoAllowReadOnly ?? g.autoAllowReadOnly) !== false,
    directorModel: modelChoice(p.directorModel ?? g.directorModel),
    workerModel: modelChoice(p.workerModel ?? g.workerModel),
    plannerModel: modelChoice(p.plannerModel ?? g.plannerModel),
    directorProviderId: str(p.directorProviderId ?? g.directorProviderId),
    workerProviderId: str(p.workerProviderId ?? g.workerProviderId),
    gitBranchPerMission: (p.gitBranchPerMission ?? g.gitBranchPerMission) !== false,
    allowWorktreeParent: (p.allowWorktreeParent ?? g.allowWorktreeParent) !== false,
    isolation: isolationChoice(p.isolation ?? g.isolation),
    maxConcurrentMissions: p.maxConcurrentMissions ?? g.maxConcurrentMissions,
    budgetWarnAt: (() => {
      const raw = Number(p.budgetWarnAt ?? g.budgetWarnAt);
      return Number.isFinite(raw) && raw > 0 && raw < 100 ? raw : 60;
    })(),
    scheduledMonthlyCapUsd: (() => {
      // Zero is a legal answer — "this project may not spend unattended at
      // all" — so only a negative or unreadable value falls back to the default.
      const raw = Number(p.scheduledMonthlyCapUsd ?? g.scheduledMonthlyCapUsd);
      return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SCHEDULED_MONTHLY_CAP_USD;
    })(),
    // The project's list replaces the global one whole, like the rest of the
    // overlay — merging would make "no reviewer on this project" unsayable.
    crewPresets: crewPresetsFrom(g, p),
  };
}

/** What missions have cost in this project and across the fleet, as the planner's anchor. */
async function budgetAnchorFor(project: Project): Promise<string> {
  const runs = await store.listRuns();
  return budgetAnchor(projectRecord(runsOfProject(runs, project)), projectRecord(runs), project.name);
}

/** Git facts per folder, for the fleet poll — asked at most every few seconds per project. */
const gitInfoCache = new Map<string, { at: number; value: GitInfo }>();
async function gitInfoCached(folder: string): Promise<GitInfo> {
  const hit = gitInfoCache.get(folder);
  if (hit && Date.now() - hit.at < 5_000) return hit.value;
  const value = await gitInfo(folder);
  gitInfoCache.set(folder, { at: Date.now(), value });
  return value;
}

/**
 * The effective isolation per project, for a few seconds — like gitInfoCache
 * and for the same reason: /projects asks isolationFor for every project on a
 * 3-second poll, and every ask reads settings.json off the disk. Cleared
 * whenever settings are written, so a human who changes the isolation sees it
 * on the next poll rather than when a timer happens to run out.
 */
const isolationCache = new Map<string, { at: number; value: { isolation: Isolation; configured: unknown } }>();
function forgetIsolation(): void {
  isolationCache.clear();
}

/**
 * How this project runs its missions, as it will actually be honoured — the
 * pair every reservation needs.
 *
 * `worktree` degrades to `shared` when the folder is not a git repository,
 * because a worktree is a git feature and there is nothing to make one from.
 * Settings refuses that combination per project when a human chooses it, but a
 * GLOBAL default of 'worktree' applies to projects nobody chose it for, and it
 * must not turn a plain folder into a worktree project — it would fail at every
 * dispatch, or worse, be read as isolation that does not exist.
 *
 * The same for a folder that is inside a repository without being its root: a
 * worktree of it would be a checkout of the whole repository, and the mission
 * would silently work somewhere other than the folder the project names.
 */
async function isolationFor(project: Project): Promise<{ isolation: Isolation; configured: unknown }> {
  const hit = isolationCache.get(project.id);
  if (hit && Date.now() - hit.at < 3_000) return hit.value;
  const value = await isolationRead(project);
  isolationCache.set(project.id, { at: Date.now(), value });
  return value;
}

/** The reading behind isolationFor, without the cache in front of it. */
async function isolationRead(project: Project): Promise<{ isolation: Isolation; configured: unknown }> {
  const settings = await effectiveSettings(project.id);
  const configured = settings.maxConcurrentMissions;
  if (settings.isolation !== 'worktree') return { isolation: 'shared', configured };
  const info = await gitInfoCached(project.folder).catch(() => ({ repo: false }) as GitInfo);
  const allowed = isolationAllowed('worktree', {
    repo: info.repo,
    root: info.root ? path.resolve(info.root) === path.resolve(project.folder) : undefined,
  });
  return { isolation: allowed.ok ? 'worktree' : 'shared', configured };
}

/** isolationFor where only a project id is at hand; an unlinked id is shared. */
async function isolationForId(projectId: string): Promise<{ isolation: Isolation; configured: unknown }> {
  const project = await store.getProject(projectId).catch(() => null);
  if (project) return isolationFor(project);
  return { isolation: 'shared', configured: (await effectiveSettings(projectId)).maxConcurrentMissions };
}

/**
 * Why this run's folder cannot be looked at, or null when it can.
 *
 * A run that finished with no commits has its worktree removed (driveRun says
 * so in the transcript), and `meta.folder` then names a directory that is not
 * there any more. Every route that reaches for those files — the pull request
 * it would draft, the file browser — otherwise answers with whatever a git
 * command or a stat says about a missing path: "the repository has no origin
 * remote to push to", or a bare 404. Neither is true, and neither tells anyone
 * what happened. This sentence does.
 *
 * Two sentences, because there are two ways a worktree goes: the automatic
 * removal of an empty one, where there genuinely is nothing to see, and a
 * removal the human asked for, where the work is still on the branch in the
 * repository and saying "it ended with no commits" would be a lie.
 */
function worktreeGoneReason(meta: RunMeta): string | null {
  const wt = meta.worktree;
  if (!wt?.removedAt) return null;
  if (meta.git?.commits) {
    return `this mission's worktree at ${wt.path} has been removed, so its files are no longer on disk; `
      + `its work is on ${meta.git.branch} in ${wt.repo}`;
  }
  return `this mission's worktree at ${wt.path} was removed because the run ended with no commits, `
    + 'so there is nothing left to push or browse';
}

/**
 * Why a resume would be refused, or null when it may go ahead.
 *
 * Asked before anything touches `meta.folder`: ensureMissionBranch would check
 * the branch out, restoreMissionDoc would write a file, and grantWorktreeParent
 * would open a directory — all of them in the project's own checkout if the
 * worktree is gone and `meta.folder` points at a path that no longer exists.
 * resumeWorktree() in src/isolation.ts owns the rule and the sentence.
 */
async function worktreeResumeRefusal(meta: RunMeta): Promise<string | null> {
  const exists = meta.worktree
    ? await stat(meta.worktree.path).then((s) => s.isDirectory()).catch(() => false)
    : false;
  const d = resumeWorktree({ worktree: meta.worktree, exists });
  return d.ok ? null : d.reason;
}

/**
 * Which run holds each repository's parent grant, keyed by the repository's
 * REALPATH. First come, held for the life of the run; repoClaim() in
 * src/isolation.ts is the rule, this is the ledger it reads.
 *
 * Realpath, not path.resolve: `git worktree list` answers with symlinks already
 * resolved, while a project folder is recorded as the human linked it, so a
 * repository reached through a symlink is two spellings of one directory — and
 * two spellings are two entries, which is every run holding the repository.
 */
const repoHolders = new Map<string, string>();

/** A path as the filesystem knows it, or the best guess when it cannot say. */
async function realPathOf(p: string): Promise<string> {
  return realpath(p).catch(() => path.resolve(p));
}

/**
 * Gives back whatever repository this run held. Called wherever a run stops
 * being a running run — beside releaseProject, on every path — because a
 * repository held by a run that is not running is a repository no other
 * mission can ever have.
 */
function releaseRepoHold(runId: string): void {
  for (const [repo, holder] of repoHolders) {
    if (holder === runId) repoHolders.delete(repo);
  }
}

/**
 * A mission in a git worktree gets its parent repository without being asked.
 *
 * The worktree holds the branch's files; the build config, the shared type
 * declarations and the parent's node_modules live up in the repository it was
 * made from. A crew working in a worktree therefore crosses the boundary on
 * almost every command, and answering the same question all day is not
 * oversight — it is noise that trains the human to click Allow without
 * reading. The parent is opened at the start instead, once, in the open: the
 * transcript records it the same way it records a human's own grant.
 *
 * Only the parent. Sibling worktrees stay closed, because one of them may be
 * another mission's workspace, and so does a parent that a live run is
 * already working in.
 */
async function grantWorktreeParent(
  meta: RunMeta, allowed: boolean, emit: ReturnType<typeof makeEmitter>,
): Promise<void> {
  // Re-derived from scratch every start and every resume, never merely added
  // to: the setting may have been turned off since, or another mission may
  // have taken the parent, and a grant that outlives its reason is a hole.
  // Only Foreman's own grants are withdrawn; a human's stay.
  const previous = meta.autoRoots ?? [];
  const shape = allowed ? await worktreeParent(meta.folder).catch(() => null) : null;
  const busy = activeRuns().filter((r) => r.meta.id !== meta.id).map((r) => r.meta.folder);
  // Exactly one live mission per repository may hold the parent. The busy-folder
  // rule inside worktreeGrant only catches a run working IN the parent, and with
  // several worktree missions in one repository no run ever is — so two grants
  // would open the same `.git`, index and lock files to two crews at once: the
  // collision worktrees exist to end, reintroduced one level up.
  //
  // A CLAIM, taken here and held until this run stops: asking which live run is
  // oldest cannot work, because this run is not in the live list yet (the grant
  // is made before driveRun attaches it) and because a resumed run keeps its
  // original start time, so an older run resuming would out-rank the incumbent
  // that already has the grant written into its metadata. The check and the
  // write are one synchronous step with no await between them, which is what
  // makes two missions dispatched in the same tick see each other.
  const key = shape ? await realPathOf(shape.parent) : null;
  const claim = shape && key
    ? repoClaim({ repo: shape.parent, holder: repoHolders.get(key), runId: meta.id })
    : null;
  if (claim?.hold && key) repoHolders.set(key, meta.id);
  const decision: { grant: string | null; reason?: string } = claim && !claim.hold
    ? { grant: null, reason: claim.reason }
    : worktreeGrant(shape, busy);
  // A claim without a grant helps nobody. If the parent stays closed for any
  // other reason — the setting turned off since, worktreeGrant's own refusal —
  // the repository goes back on the shelf for another mission to take.
  if (!decision.grant) releaseRepoHold(meta.id);
  const now = decision.grant ? [decision.grant] : [];
  const withdrawn = previous.filter((p) => !now.includes(p));

  if (withdrawn.length || now.some((p) => !previous.includes(p))) {
    meta.allowedRoots = [...(meta.allowedRoots ?? []).filter((p) => !previous.includes(p)), ...now];
    meta.autoRoots = now;
    await store.writeMeta(meta).catch(() => {});
  }
  for (const p of withdrawn) {
    emit('git_note', { text: `Closed ${p} again: ${decision.reason ?? 'Foreman no longer opens it for this mission'}. The crew will ask before it steps outside the mission folder.` });
  }
  if (decision.grant && !previous.includes(decision.grant)) {
    emit('root_allowed', {
      path: decision.grant, agent: 'foreman',
      reason: 'this mission runs in a worktree of that repository',
    });
  } else if (!decision.grant && decision.reason && !withdrawn.length) {
    emit('git_note', { text: `Left closed: ${decision.reason}. The crew will ask before it steps outside the mission folder.` });
  }
}

async function startRun(
  // `ticket` is the reservation this mission starts under — taken by the
  // caller before its dispatch (see reserveProject) and given back by driveRun.
  //
  // `isolation` is the one the reservation was granted under, handed in rather
  // than read again here. The reservation and the workspace MUST come from the
  // same read: the limit that allowed a second mission is the worktree limit,
  // so if the project were flipped to 'shared' in the window between the
  // reservation and this point, both reserved runs would start in the project's
  // own checkout — the collision worktrees exist to end.
  projectId: string, ticket: string, isolation: Isolation, folder: string, mission: string, budgetUsd: number,
  directorModel: ModelChoice, workerModel: ModelChoice, browserTools: boolean,
  provider: ProviderRef,
  roleProviders: { director?: string; worker?: string } = {},
  /**
   * How this run began. Recorded rather than inferred: an unattended run and
   * one somebody is watching deserve different treatment later, and the
   * schedule's monthly ceiling can only count what says it was scheduled.
   */
  origin: {
    startedBy?: 'human' | 'phone' | 'schedule' | 'mcp';
    scheduleId?: string;
    scheduleName?: string;
  } = {},
  /**
   * Crew presets the human opted this mission into, by id. Resolved and copied
   * onto the record here and nowhere else: the run is reviewed against the
   * presets as they stood when it started, whatever Settings says later.
   */
  crewIds?: readonly string[],
): Promise<void> {
  const settings = await effectiveSettings(projectId);
  if (origin.scheduleId && origin.scheduleName) scheduleNames.set(origin.scheduleId, origin.scheduleName);
  const meta: RunMeta = {
    id: newRunId(),
    projectId,
    folder, mission, budgetUsd,
    startedBy: origin.startedBy ?? 'human',
    ...(origin.scheduleId ? { scheduleId: origin.scheduleId } : {}),
    // An explicit composer choice wins; "Default" inherits from Settings.
    directorModel: directorModel ?? settings.directorModel,
    workerModel: workerModel ?? settings.workerModel,
    // Which provider serves each role — from the model that was picked, so
    // choosing a model chooses where that role runs.
    directorProviderId: roleProviders.director ?? settings.directorProviderId,
    workerProviderId: roleProviders.worker ?? settings.workerProviderId,
    ownerPid: process.pid,
    browserTools: browserTools || undefined,
    budgetWarnAt: settings.budgetWarnAt,
    toolPolicy: settings.toolPolicy,
    autoAllowReadOnly: settings.autoAllowReadOnly,
    // Frozen at dispatch: a later change to the project or the server default
    // must not silently move an in-flight or resumed run to another provider,
    // or another bill.
    provider,
    // Frozen for the same reason as the provider, and against a stronger
    // temptation: a preset edited next week must not change what a run that is
    // still going — or one that finished in March — was reviewed against.
    ...(() => {
      const crew = frozenCrewFor(settings.crewPresets, crewIds);
      return crew ? { crew } : {};
    })(),
    status: 'running', costUsd: 0,
    createdAt: Date.now(), workers: [],
  };
  try {
    await store.createRun(meta);
  } catch (err) {
    releaseProject(projectId, ticket);
    console.error(`failed to create run for project ${projectId}:`, err);
    return;
  }
  // Whoever reads this transcript later did not start this run, and the first
  // question they will have is who did. It is the opening line, before the
  // branch note, so the answer is at the top rather than buried in the meta.
  if (origin.scheduleId) {
    const emit = makeEmitter(meta.id, projectId);
    emit('run_note', {
      text: `Started by schedule ${origin.scheduleName ?? scheduleNames.get(origin.scheduleId) ?? origin.scheduleId}.`,
    });
  }
  // The schedule's "last run" is this one, recorded the moment it exists
  // rather than when it ends: a schedule whose mission is still running should
  // point at it, not at the one before.
  if (origin.scheduleId) {
    await store.updateSchedule(origin.scheduleId, {
      lastRunId: meta.id, lastRunAt: meta.createdAt, lastNote: '',
    }).catch(() => {});
  }
  await consumeProposal(projectId, meta.id, mission).catch(() => {});
  // A worktree project gives this mission a checkout of its own before anything
  // else looks at `meta.folder`: from here on the run works in the worktree,
  // and the project's folder is only its `repo`.
  if (isolation === 'worktree') {
    const emit = makeEmitter(meta.id, projectId);
    const wt = await addMissionWorktree(folder, worktreePath(store.root, projectId, meta.id), mission, meta.id);
    if ('error' in wt) {
      // No fallback to the project folder. This project may already have
      // another mission running in that checkout, and dropping this one into it
      // is exactly the collision worktrees exist to end — so the run fails here
      // instead, with git's own reason, and the human decides what to do.
      meta.status = 'error';
      meta.endedAt = Date.now();
      await store.writeMeta(meta).catch(() => {});
      emit('run_error', { error: `could not make this mission a worktree of ${folder}: ${wt.error}` });
      emit('run_finished', { status: 'error', costUsd: 0 });
      releaseRepoHold(meta.id);
      releaseProject(projectId, ticket);
      return;
    }
    meta.folder = wt.path;
    meta.worktree = { path: wt.path, repo: folder, base: wt.base };
    // The worktree was created ON the mission branch, so this is the same
    // record `startMissionBranch` would have written — and the reason that
    // block below is skipped for such a run.
    meta.git = { branch: wt.branch, base: wt.base, baseHead: wt.baseHead };
    await store.writeMeta(meta).catch(() => {});
    // Both folders changed: the project's checkout gained a worktree, and the
    // new one has git facts of its own that nothing has asked for yet.
    gitInfoCache.delete(folder);
    gitInfoCache.delete(wt.path);
    emit('git_branch', {
      branch: wt.branch, base: wt.base,
      text: `This mission runs in a worktree of ${folder} at ${wt.path}, on branch ${wt.branch} made from the repository's default branch ${wt.base}. `
        + `The project's own checkout is untouched — it stays on whatever branch you left it on, and other missions can run there at the same time. `
        + `Foreman commits the mission's work on ${wt.branch} when it ends; merging and pushing stay yours.`,
    });
  }
  // The folder's MISSION.md belongs to whichever run wrote it. Parked into
  // that run's record (when it lacks one) and cleared, so this run's status
  // reads empty until its own director writes the plan — not 13/14 done.
  // Skipped for a worktree run: a checkout made seconds ago has no MISSION.md
  // to park, and the folder whose copy would be at stake is the project's,
  // which this mission never touches.
  if (!meta.worktree) {
    const previous = (await store.listRuns().catch(() => [] as RunMeta[]))
      .find((r) => r.projectId === projectId && r.id !== meta.id && r.status !== 'running');
    await parkMissionDoc(folder, previous ? store.runDirectory(previous.id) : null).catch(() => {});
  }
  // In a repository, the mission gets a branch of its own before the crew
  // touches anything — so the deck's baseline, taken at the director's first
  // turn, is the branch point, and the diff is exactly the mission.
  // A worktree run already has one (above), and its fresh checkout carried
  // nothing along, so neither the branch nor the uncommitted-work note applies.
  if (settings.gitBranchPerMission && !meta.worktree) {
    const carried = await dirtyPaths(folder);
    const g = await startMissionBranch(folder, mission, meta.id);
    const emit = makeEmitter(meta.id, projectId);
    if ('error' in g) {
      if (g.error !== 'not a git repository') emit('git_note', { text: `Could not give this mission its own branch (${g.error}); running on the current branch.` });
    } else {
      meta.git = g;
      await store.writeMeta(meta).catch(() => {});
      gitInfoCache.delete(folder);
      emit('git_branch', { branch: g.branch, base: g.base, text: `On branch ${g.branch}, made from ${g.base}. Foreman commits the mission's work here when it ends; merging and pushing stay yours.` });
      // Whoever started this may not have been at the keyboard to be asked.
      if (carried.length) {
        emit('git_note', {
          text: `The checkout had uncommitted changes when this mission started, and they came along to ${g.branch}: `
            + `${carried.slice(0, 5).join(', ')}${carried.length > 5 ? `, and ${carried.length - 5} more` : ''}. `
            + "They will be part of the mission's closing commit unless you take them off the branch first.",
        });
      }
    }
  }
  await grantWorktreeParent(meta, settings.allowWorktreeParent, makeEmitter(meta.id, projectId));
  await driveRun(projectId, ticket, meta);
}

/**
 * Resumes an interrupted run by restoring the director's session. `pick`
 * carries models chosen for this resume (the header's "Resume on…"); a role
 * it names wins over Settings for that role.
 */
async function resumeRun(projectId: string, ticket: string, meta: RunMeta, pick: {
  directorModel?: string; directorProviderId?: string; workerModel?: string; workerProviderId?: string;
  /** A new cap for the resumed attempt — the answer to "stopped at its budget". */
  budgetUsd?: number;
} = {}): Promise<void> {
  // Before anything reads meta.folder. A run recorded as living in a worktree
  // that is gone is not resumed in the project's checkout instead — see
  // resumeWorktree(). The route asks first so the human gets a 409; this is the
  // same guard for any other caller, and it records the reason in the
  // transcript before giving the reservation back untouched.
  const refused = await worktreeResumeRefusal(meta);
  if (refused) {
    makeEmitter(meta.id, projectId)('run_note', { text: `Not resumed: ${refused}.` });
    releaseRepoHold(meta.id);
    releaseProject(projectId, ticket);
    return;
  }
  const sessionId = meta.directorSessionId;
  // Resume re-reads Settings for tool policy and auto-allow, so a policy
  // change after a failure takes effect on the retry. Models are the run's
  // own unless "Resume on…" says otherwise; a changed director model then
  // restarts the session fresh (the mission doc carries the state forward).
  const settings = await effectiveSettings(projectId);
  // A plain Resume keeps the run's own models. It used to re-read the
  // project's Settings and treat any difference as "the human changed the
  // model" — but a run whose models were chosen at start (a local model
  // picked on the card) differs from Settings by construction, and one
  // Resume silently handed a 9B local-model test to Fable and Opus, at $4.82,
  // and called the result the 9B's. Changing models on resume is now only
  // ever explicit: "Resume on…" passes `pick`. A model is picked together
  // with the provider that serves it; a pick without a provider id means the
  // project's own provider, as at start.
  const directorChanged = Boolean(pick.directorModel) && (
    modelChoice(pick.directorModel) !== meta.directorModel || pick.directorProviderId !== meta.directorProviderId);
  const workerChanged = Boolean(pick.workerModel) && (
    modelChoice(pick.workerModel) !== meta.workerModel || pick.workerProviderId !== meta.workerProviderId);
  if (directorChanged) { meta.directorModel = modelChoice(pick.directorModel); meta.directorProviderId = pick.directorProviderId; }
  if (workerChanged) { meta.workerModel = modelChoice(pick.workerModel); meta.workerProviderId = pick.workerProviderId; }
  meta.toolPolicy = settings.toolPolicy;
  meta.autoAllowReadOnly = settings.autoAllowReadOnly;
  // A raised cap rides the resume: the run that stopped at $10 continues
  // under $15, and the transcript says who moved it and from where. Written
  // to the log as a settings change, which is what it is.
  const budgetWas = meta.budgetUsd;
  if (typeof pick.budgetUsd === 'number' && Number.isFinite(pick.budgetUsd) && pick.budgetUsd > 0 && pick.budgetUsd !== meta.budgetUsd) {
    meta.budgetUsd = pick.budgetUsd;
  }
  const stoppedAt = meta.stopReason;
  meta.stopReason = undefined;
  meta.status = 'running';
  meta.endedAt = undefined;
  meta.ownerPid = process.pid;
  meta.resumes = (meta.resumes ?? 0) + 1;
  if (meta.budgetUsd !== budgetWas) {
    makeEmitter(meta.id, projectId)('settings_changed', {
      budgetUsd: meta.budgetUsd,
      changes: [`Budget ${meta.budgetUsd > budgetWas ? 'raised' : 'lowered'} to $${meta.budgetUsd.toFixed(2)} (was $${budgetWas.toFixed(2)}) before resume${stoppedAt === 'budget' ? ' — the last attempt stopped at its cap' : ''}.`],
    });
  }
  if (meta.git) {
    const back = await ensureMissionBranch(meta.folder, meta.git.branch);
    if (back) makeEmitter(meta.id, projectId)('git_note', { text: `Could not return to ${meta.git.branch} (${back}); the resumed mission runs on whatever is checked out.` });
    gitInfoCache.delete(meta.folder);
  }
  await grantWorktreeParent(meta, (await effectiveSettings(projectId)).allowWorktreeParent, makeEmitter(meta.id, projectId));
  // The director resumes from MISSION.md. If another mission ran here since,
  // the folder's copy is that mission's; this run's own goes back first.
  const restored = await restoreMissionDoc(store.runDirectory(meta.id), meta.folder).catch(() => 'none' as const);
  if (restored === 'restored') {
    const emit = makeEmitter(meta.id, projectId);
    emit('mission_doc_restored', {
      text: 'Restored this run\'s own MISSION.md into the folder before resuming; a later mission had overwritten it.',
    });
  }
  await store.writeMeta(meta).catch((err) => {
    console.error(`failed to persist resume of ${meta.id}:`, err);
  });
  // Always a resume, even when the model change forces a fresh session.
  await driveRun(projectId, ticket, meta, { sessionId: directorChanged ? undefined : sessionId }, {
    directorChanged, workerChanged,
  });
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * Starts a schedule's mission. The project must already be reserved, and
 * `isolation` is the one that reservation was granted under — see startRun for
 * why the reservation and the workspace must come from one read.
 *
 * The schedule's own choices win; anything it leaves open falls back to the
 * project's effective settings, which is what startRun does with an absent
 * model anyway. The browser judgement is the same heuristic the phone's /run
 * uses, and for the same reason: there is no box for anyone to tick.
 */
function startScheduledRun(
  s: Schedule, ticket: string, isolation: Isolation, project: Project, startedBy: 'human' | 'schedule',
): void {
  dispatch(s.projectId, ticket, startRun(
    s.projectId, ticket, isolation, project.folder, s.brief, s.budgetUsd,
    modelChoice(s.directorModel), modelChoice(s.workerModel),
    /screenshot|browser|render|console/i.test(s.brief),
    providerOf(project),
    { director: s.directorProviderId, worker: s.workerProviderId },
    { startedBy, scheduleId: s.id, scheduleName: s.name },
  ));
}

/** The next firing of this cadence as a timestamp, or null when there is none. */
function nextRunAtMs(cadence: Cadence, after: Date): number | null {
  const next = nextRunAt(cadence, after);
  return next ? next.getTime() : null;
}

/**
 * A scheduled run ended: the schedule remembers how it went.
 *
 * Two failures in a row pause it — see afterRunOutcome. Called from the
 * emitter, which is where the server learns a run finished; the orchestrator
 * knows nothing about schedules and should not have to.
 */
async function recordScheduleOutcome(scheduleId: string, meta: RunMeta): Promise<void> {
  const s = await store.getSchedule(scheduleId);
  if (!s) return;
  const outcome = afterRunOutcome(s, { status: meta.status, stopReason: meta.stopReason });
  await store.updateSchedule(s.id, {
    lastRunId: meta.id,
    lastRunAt: meta.endedAt ?? Date.now(),
    lastOutcome: meta.status === 'running' ? undefined : meta.status,
    // Whatever the last tick could not do, it did this time: the note would
    // otherwise still read "project busy" beside a run that just finished.
    lastNote: '',
    consecutiveFailures: outcome.consecutiveFailures,
    pausedReason: outcome.pausedReason,
  });
  if (outcome.pausedNow) {
    const emit = scheduleNotice(s.projectId);
    emit('schedule_paused', { scheduleId: s.id, name: s.name, projectId: s.projectId, reason: 'failures' });
  }
}

/**
 * One pass of the ticker: what is due, and what to do about it.
 *
 * Passes must not overlap. A pass awaits the store several times, and two of
 * them interleaving could both see the same schedule as due and start it
 * twice — the project reservation would catch that, but as a 409 nobody is
 * there to read rather than as a rule.
 */
let tickInFlight = false;
async function scheduleTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const schedules = await store.listSchedules();
    if (!schedules.length) return;
    for (const s of schedules) scheduleNames.set(s.id, s.name);
    const now = new Date();
    // A schedule with no next firing would sit dormant for ever — a record
    // written by an older build, or one whose cadence was never scheduled.
    // Giving it one here costs a write once and never again.
    for (const s of schedules) {
      if (!s.enabled || s.pausedReason !== null || s.nextRunAt !== null) continue;
      s.nextRunAt = nextRunAtMs(s.cadence, now);
      await store.updateSchedule(s.id, { nextRunAt: s.nextRunAt }).catch(() => {});
    }
    const runs = await store.listRuns().catch(() => [] as RunMeta[]);
    const monthSpend = new Map<string, number>();
    const caps = new Map<string, number>();
    const isolations = new Map<string, { isolation: Isolation; configured: unknown }>();
    // "Busy" means "cannot take another mission right now", not "has one".
    // A worktree project with a limit of three and one mission running is not
    // busy, and a schedule that fires into it must not be skipped.
    const busy = new Set<string>();
    for (const projectId of new Set(schedules.map((s) => s.projectId))) {
      monthSpend.set(projectId, monthlyScheduledSpend(runs, projectId, now));
      caps.set(projectId, (await effectiveSettings(projectId)).scheduledMonthlyCapUsd);
      const iso = await isolationForId(projectId);
      isolations.set(projectId, iso);
      // A schedule always starts a NEW run, so its workspace is the project's
      // own isolation — the same pair reserveProject will ask with in a moment.
      const decided = reservationDecision({
        live: liveCountOf(projectId), ...iso,
        workspace: iso.isolation, sharedLive: sharedLiveOf(projectId),
      });
      if (!decided.ok) busy.add(projectId);
    }
    const actions = decideTicks({
      schedules,
      now,
      busyProjectIds: busy,
      monthSpend,
      capFor: (projectId) => caps.get(projectId) ?? DEFAULT_SCHEDULED_MONTHLY_CAP_USD,
    });
    for (const action of actions) {
      const s = schedules.find((x) => x.id === action.scheduleId);
      if (!s) continue;
      if (action.kind === 'pause') {
        await store.updateSchedule(s.id, { pausedReason: action.reason }).catch(() => {});
        const emit = scheduleNotice(s.projectId);
        emit('schedule_paused', {
          scheduleId: s.id, name: s.name, projectId: s.projectId, reason: action.reason,
        });
        continue;
      }
      const skipped = async (nextAt: number | null) => {
        await store.updateSchedule(s.id, {
          nextRunAt: nextAt, lastOutcome: 'skipped', lastNote: 'project busy',
        }).catch(() => {});
        const emit = scheduleNotice(s.projectId);
        emit('schedule_skipped', {
          scheduleId: s.id, name: s.name, projectId: s.projectId, reason: 'project busy',
        });
      };
      if (action.kind === 'skip') { await skipped(action.nextRunAt); continue; }
      const project = await store.getProject(s.projectId).catch(() => null);
      if (!project) {
        // The project was unlinked and this schedule outlived it. Nothing to
        // announce; move it along so the tick does not repeat every 30s.
        await store.updateSchedule(s.id, { nextRunAt: action.nextRunAt }).catch(() => {});
        continue;
      }
      // Reservation is the last step before dispatch — no awaits in between,
      // exactly as in POST /run. It can still fail: another dispatch may have
      // taken the project since this pass read the active map, and that is the
      // skip case, not a tick to drop on the floor.
      const iso = isolations.get(s.projectId) ?? { isolation: 'shared' as Isolation, configured: undefined };
      const reserved = reserveProject(s.projectId, { ...iso, projectName: project.name });
      if ('error' in reserved) { await skipped(action.nextRunAt); continue; }
      startScheduledRun(s, reserved.ticket, iso.isolation, project, 'schedule');
      await store.updateSchedule(s.id, { nextRunAt: action.nextRunAt }).catch(() => {});
    }
  } catch (err) {
    // A ticker that throws is a ticker that stops. Nothing here is worth the
    // schedules of every other project.
    console.error('schedule tick failed:', err);
  } finally {
    tickInFlight = false;
  }
}

// Every half minute, and once shortly after startup so a firing missed while
// the machine was off is caught up rather than waiting for the next slot. The
// first pass is delayed: the orphan sweep and the store's own startup work
// come first, and a schedule is never so urgent that ten seconds matter.
setTimeout(() => void scheduleTick(), 10_000).unref();
setInterval(() => void scheduleTick(), 30_000).unref();

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.woff2': 'font/woff2',
};

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const distFile = path.resolve(DIST_DIR, rel);
  if (!distFile.startsWith(DIST_DIR + path.sep) && distFile !== path.join(DIST_DIR, 'index.html')) {
    return false;
  }
  const body = await readFile(distFile).catch(() => null);
  if (!body) {
    if (pathname !== '/') return false;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>Foreman</h1><p>UI bundle missing — run <code>npm run ui:build</code> and reload.</p>');
    return true;
  }
  const type = MIME[path.extname(rel)] ?? 'application/octet-stream';
  // index.html must never be cached — it points at hashed asset names.
  const cache = rel === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  res.end(body);
  return true;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * The request body as an object, refusing to buffer more than the route's cap.
 *
 * Both failures throw a `BodyError`, which the handler's outer catch turns
 * into the client's own status instead of a 500 that reads like a Foreman bug:
 * 413 when the body outgrows the cap (see `src/http-body.ts` for why there is
 * one), 400 when what arrived is not JSON. Content-Length is consulted first
 * so an oversized upload is refused before a single byte is read.
 */
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const pathname = new URL(req.url ?? '/', `http://localhost:${PORT}`).pathname;
  const limit = bodyLimitFor(req.method, pathname);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyError(413, 'request body too large');
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    seen += buf.length;
    if (seen > limit) throw new BodyError(413, 'request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return parseBody(Buffer.concat(chunks));
}

/**
 * The folders the folder picker may look inside.
 *
 * `/browse` and `/mkdir` exist to let the human point at a project, and they
 * took any absolute path — which made them a directory listing and a
 * `mkdir -p` for the whole filesystem, reachable from a page that got past
 * nothing but a URL. The answer is the same one the permission cards use:
 * name the places a project could plausibly live — the home directory, the
 * configured projects root (it may be on another volume), and every folder
 * already linked as a project — and refuse the rest. Read afresh per request
 * because linking a project is what widens the set.
 */
async function browseRoots(): Promise<string[]> {
  const settings = await store.readSettings().catch(() => ({ global: {} as Record<string, unknown> }));
  const roots = [
    os.homedir(),
    projectsRoot((settings.global as Record<string, unknown>).projectsRoot),
  ];
  for (const p of await store.listProjects().catch(() => [])) roots.push(p.folder);
  return roots;
}

/**
 * A schedule's writable fields out of a request body, or the first thing wrong
 * with them. `partial` is the PUT: an absent field means "leave it alone",
 * where on the POST it means the schedule would be missing something it needs.
 *
 * The cadence goes through validateCadence rather than being trusted, because
 * the failure this guards against is silent — a cron expression nobody can
 * parse becomes a schedule that simply never fires, and looks healthy doing it.
 */
function parseScheduleBody(
  b: Record<string, unknown>, partial: boolean,
): { error: string } | { fields: Partial<Schedule> } {
  const fields: Partial<Schedule> = {};
  for (const key of ['name', 'brief'] as const) {
    if (b[key] === undefined) {
      if (!partial) return { error: `${key} is required` };
      continue;
    }
    const v = typeof b[key] === 'string' ? (b[key] as string).trim() : '';
    if (!v) return { error: `${key} must not be empty` };
    fields[key] = v;
  }
  if (b.budgetUsd !== undefined) {
    const n = Number(b.budgetUsd);
    if (!Number.isFinite(n) || n <= 0) return { error: 'budgetUsd must be a positive number' };
    fields.budgetUsd = n;
  } else if (!partial) {
    return { error: 'budgetUsd is required' };
  }
  if (b.cadence !== undefined) {
    const parsed = validateCadence(b.cadence);
    if (!parsed.ok) return { error: parsed.error };
    fields.cadence = parsed.cadence;
  } else if (!partial) {
    return { error: 'cadence is required' };
  }
  for (const key of ['directorModel', 'workerModel'] as const) {
    if (typeof b[key] === 'string' && (b[key] as string).trim()) fields[key] = modelChoice(b[key]);
  }
  for (const key of ['directorProviderId', 'workerProviderId'] as const) {
    if (typeof b[key] === 'string' && (b[key] as string).trim()) fields[key] = (b[key] as string).trim();
  }
  if (typeof b.enabled === 'boolean') fields.enabled = b.enabled;
  return { fields };
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // Before any route, including the service proxy: is this request one we
  // should be answering at all? Foreman has no login, so a browser that can
  // reach the port can otherwise act as the operator — a page on any domain
  // can point that name at 127.0.0.1 (DNS rebinding) or simply POST at
  // localhost from whatever tab the operator has open. See src/guard.ts.
  const verdict = requestAllowed(req, { port: PORT, tailnet, bindAll: BIND === 'all' });
  if (!verdict.ok) { json(res, verdict.status, { error: verdict.error }); return; }
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  // Note: /svc/… is not handled here. Exposed dev servers live on
  // SERVICES_PORT, on their own origin — see servicesServer below.
  const runEventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
  // A run whose worktree was removed has no folder left to browse, and the
  // viewer's 404 would say only "not found". Answered here, before the deck
  // router resolves a path that is not there, so the run page can say what
  // became of the files. The deck itself is exempt: a finished run's deck is
  // the frozen one from its record, which outlives the worktree it described.
  const runFilesMatch = url.pathname.match(/^\/runs\/([^/]+)\/(artifact|preview)(?:\/|$)/);
  if (runFilesMatch) {
    const m = await store.readMeta(runFilesMatch[1]).catch(() => null);
    const gone = m ? worktreeGoneReason(m) : null;
    if (gone) return json(res, 409, { error: gone, code: 'worktree-removed' });
  }
  // The deck: what a run changed and what it produced. Read-only by design —
  // a stated non-goal — and handled before the chain because it owns two paths
  // under /runs/{id}/ that nothing else claims.
  if (await handleDeckRoute(req, res, url, async (scope, id) => {
    if (scope === 'projects') {
      const project = await store.getProject(id).catch(() => null);
      return project ? { folder: project.folder } : null;
    }
    const m = await store.readMeta(id).catch(() => null);
    if (!m) return null;
    const frozen = m.status !== 'running' ? await frozenDeck(store.runDirectory(m.id)) : null;
    return { folder: m.folder, ...(frozen ? { deck: frozen } : {}) };
  })) return;
  const runResumeMatch = url.pathname.match(/^\/runs\/([^/]+)\/resume$/);
  const prMatch = url.pathname.match(/^\/runs\/([^/]+)\/pr$/);
  const prStateMatch = url.pathname.match(/^\/runs\/([^/]+)\/pr\/state$/);
  const runServicesMatch = url.pathname.match(/^\/runs\/([^/]+)\/services$/);
  const stopServiceMatch = url.pathname.match(/^\/runs\/([^/]+)\/services\/(\d{1,5})\/stop$/);
  const worktreeRemoveMatch = url.pathname.match(/^\/runs\/([^/]+)\/worktree\/remove$/);
  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
  const providerKeyMatch = url.pathname.match(/^\/providers\/([A-Za-z0-9_-]{1,64})\/key$/);
  const projectSchedulesMatch = url.pathname.match(/^\/projects\/([^/]+)\/schedules$/);
  const scheduleMatch = url.pathname.match(/^\/schedules\/([^/]+)$/);
  const scheduleActionMatch = url.pathname.match(/^\/schedules\/([^/]+)\/(pause|resume|run-now)$/);

  try {
    if (req.method === 'GET' && (url.pathname === '/'
      || url.pathname.startsWith('/assets/')
      // Root-level static files Vite emits from ui/public. Listed explicitly so
      // a stray path can never shadow an API route.
      || ROOT_ASSETS.has(url.pathname))) {
      if (!(await serveStatic(url.pathname, res))) json(res, 404, { error: 'not found' });

    } else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));

    } else if (req.method === 'GET' && url.pathname === '/doctor') {
      // What `foreman doctor` prints, as data, for the dashboard's setup card.
      // Computed fresh each time — the point is to reflect a login or an
      // install the person just did. The port and dashboard checks are left
      // out: whoever is reading this in the dashboard already knows both.
      const [checks, auth, ollama, codexAuth, notify] = await Promise.all([
        preflight({ port: PORT, servicesPort: SERVICES_PORT, foremanHome: store.root, distDir: DIST_DIR, tailnet }),
        detectAuth(),
        discoverOllama(1200),
        readCodexAuth(codexHome()).catch(() => null),
        notifySettings().catch(() => null),
      ]);
      const codexCount = codexAuth ? (await codexModels(codexHome()).catch(() => [])).length : 0;
      json(res, 200, {
        checks: checks.filter((c) => !c.name.startsWith('Port') && c.name !== 'Dashboard'),
        // The same facts, shaped for the first-run pages: one object per step.
        auth: { mode: auth.mode, source: auth.source, account: auth.account ?? null },
        ollama: ollama ? { host: ollamaHost(), models: ollama.length, local: ollama.filter((m) => !m.remote).length } : null,
        codex: codexAuth ? { models: codexCount } : null,
        tailnet: tailnet ? { dnsName: tailnet.dnsName ?? null, ip: tailnet.ip, url: tailnetUrl(tailnet, PORT), https: Boolean(tailnet.httpsPort) } : null,
        phone: notify?.telegramChatId ? { label: notify.telegramChatLabel ?? 'linked', bot: notify.telegramBot ?? null } : notify?.telegramBot ? { label: null, bot: notify.telegramBot } : null,
        browser: checks.find((c) => c.name === 'Browser') ?? null,
        version: currentVersion(),
      });

    } else if (req.method === 'POST' && url.pathname === '/setup/browser') {
      // Install Playwright's Chromium, as the user, into Playwright's cache.
      // The one install action the setup page has: no root, no system
      // packages, and the crew's browser tool can drive the result.
      const running = [...installJobs.values()].find((j) => j.state === 'running');
      if (running) return json(res, 202, { id: running.id });
      const job: InstallJob = { id: crypto.randomBytes(6).toString('hex'), what: 'chromium', startedAt: Date.now(), state: 'running', progress: 'Starting…' };
      installJobs.set(job.id, job);
      void installChromium((l) => { job.progress = l; }).then((failed) => {
        if (failed) { job.state = 'error'; job.error = failed; } else { job.state = 'done'; job.progress = 'Installed'; }
        setTimeout(() => installJobs.delete(job.id), 10 * 60_000).unref();
      });
      json(res, 202, { id: job.id });

    } else if (req.method === 'GET' && url.pathname.startsWith('/setup/browser/')) {
      const job = installJobs.get(url.pathname.split('/').pop()!);
      if (!job) return json(res, 404, { error: 'no such install' });
      json(res, 200, job);

    } else if (req.method === 'POST' && url.pathname === '/setup/done') {
      // The first-run pages were seen through (or skipped). Remembered in
      // settings so they do not come back; `#/setup` reopens them on purpose.
      const current = await store.readSettings();
      await store.writeSettings({ ...current, global: { ...current.global, setupDoneAt: Date.now() } });
      forgetIsolation();
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && url.pathname === '/settings') {
      json(res, 200, await store.readSettings());

    } else if (req.method === 'PUT' && url.pathname === '/settings') {
      const { global: g, projectId, project } = await readBody(req);
      const current = await store.readSettings();
      const next = {
        global: typeof g === 'object' && g !== null ? g as Record<string, unknown> : current.global,
        projects: { ...current.projects },
      };
      if (typeof projectId === 'string' && projectId) {
        if (typeof project === 'object' && project !== null && Object.keys(project).length) {
          // A project told to run its missions in worktrees must be a git
          // repository; refused here, where the human is standing, rather than
          // at every later dispatch. Only the PROJECT overlay is checked: a
          // GLOBAL default of 'worktree' is a preference for the projects that
          // can honour it, and isolationFor() degrades it to 'shared' for the
          // plain folders — refusing it would make the default unsettable for
          // anyone with one non-repository project.
          // A subdirectory of a repository is refused too: git says it is
          // inside a work tree, but a worktree of it is the whole repository.
          const wanted = isolationChoice((project as Record<string, unknown>).isolation);
          const linked = await store.getProject(projectId).catch(() => null);
          const info = linked ? await gitInfoCached(linked.folder).catch(() => null) : null;
          const allowed = isolationAllowed(wanted, {
            repo: Boolean(info?.repo),
            root: info?.root && linked ? path.resolve(info.root) === path.resolve(linked.folder) : undefined,
          });
          if (!allowed.ok) return json(res, 400, { error: allowed.reason });
          next.projects[projectId] = project as Record<string, unknown>;
        } else {
          delete next.projects[projectId];
        }
      }
      await store.writeSettings(next);
      // The isolation of any project may have just changed — a project overlay
      // directly, a global default for every project that inherits it.
      forgetIsolation();
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && url.pathname === '/models') {
      // Every model this machine can reach, not just the project's provider's.
      //
      // Scoping the list to one provider made the configuration most worth
      // having unbuildable: a capable director with cheap local workers needs
      // two providers in one run, and a caged picker could only offer one.
      // A model now carries the provider that serves it, so choosing a model
      // chooses a provider — which is how people actually think about it.
      const forProject = url.searchParams.get('projectId');
      const project = forProject ? await store.getProject(forProject) : null;
      json(res, 200, await availableModels(project));

    } else if (req.method === 'GET' && url.pathname === '/projects') {
      const [projects, allRuns, auth, settingsFile] = await Promise.all([
        store.listProjects(), store.listRuns(), authPromise,
        store.readSettings().catch(() => ({ global: {} as Record<string, unknown>, projects: {} })),
      ]);
      // A first run: nothing linked, nothing ever run, the setup pages not
      // yet seen. An install upgraded from before the pages existed has
      // projects, so it never sees them uninvited.
      const firstRun = !projects.length && !allRuns.length && !(settingsFile.global as Record<string, unknown>).setupDoneAt;
      const cards = await Promise.all(projects.map(async (p) => {
        // Every live mission in this project, newest first. A worktree project
        // can have several, and `run` is the newest of them — what a surface
        // that still shows one mission per project should show.
        const live = liveRunsOf(p.id);
        const run = live[0] ?? null;
        const plannerAsk = pendingChatQuestion(p.id);
        // Newest finished run for the idle-card summary (runs are newest-first).
        const lastRun = allRuns.find((r) => r.projectId === p.id && r.status !== 'running') ?? null;
        // Two scalars rather than the settings behind them: this payload is
        // re-polled for every project every few seconds, and the UI's only
        // question is whether a second mission may be started here.
        const iso = await isolationFor(p);
        return {
          ...p,
          // The EFFECTIVE isolation — 'worktree' degraded to 'shared' for a
          // folder that is not a repository, exactly as a dispatch would read it.
          isolation: iso.isolation,
          // How many missions may run here at once, clamped: the same number
          // reserveProject will enforce.
          missionLimit: concurrencyLimit(iso.isolation, iso.configured),
          // What THIS project will actually bill, which can differ from the
          // server's mode when the pin opts out of the inherited key.
          billingMode: await projectBilling(p, auth.mode),
          // Whether a key is on file, never the key. Settings renders
          // "stored / not stored" from this and nothing more.
          providerHasKey: await providerHasKeyOf(p),
          // Which branch the folder is on, and whether it is dirty — the
          // header's pill, and what "a branch per mission" starts from.
          git: await gitInfoCached(p.folder),
          activeRuns: live.map((r) => ({ ...r.meta })),
          // Kept beside activeRuns, as activeRuns[0]: a client from before the
          // list existed — a phone on an old bundle, a script — still reads a
          // running mission here rather than nothing.
          activeRun: run ? { ...run.meta } : null,
          lastRun: lastRun && {
            id: lastRun.id,
            mission: lastRun.mission, title: lastRun.title, status: lastRun.status,
            createdAt: lastRun.createdAt, costUsd: lastRun.costUsd,
            // The card may print a dollar only where the dollar was real.
            costBasis: costBasisOf(lastRun), usage: lastRun.usage,
            // Not the verdicts themselves — see reviewedByNames. The tile
            // renders a glyph and a name, and this projection is polled for
            // every project every few seconds.
            reviewedBy: reviewedByNames(lastRun),
          },
          // When this project last did anything, so the fleet can lead with it.
          // A planner parked on a question is doing something — waiting on
          // you — and a never-run project falls back to when it was linked.
          lastActivityAt:
            plannerAsk?.askedAt ?? run?.meta.createdAt ?? lastRun?.endedAt ?? lastRun?.createdAt ?? p.createdAt,
          // Summed over every live mission: the card's badge answers "how much
          // is waiting on me in this project", and two missions each parked on
          // an approval are two things waiting.
          pendingPermissions: live.reduce((n, r) => n + r.pendingPermissionIds.length, 0),
          // A planner question blocks the human exactly as a director's does,
          // so it counts here: the card floats to the top tier and wears the
          // strip. `plannerQuestion` lets the strip say which one it is.
          pendingQuestions: live.reduce((n, r) => n + r.pendingQuestionIds.length, 0) + (plannerAsk ? 1 : 0),
          plannerQuestion: Boolean(plannerAsk),
          // Everything blocking on the human, with enough to answer it from
          // the board: the same ids the tab's cards resolve, so a click here
          // and a click there are the same call. Across all live missions,
          // each entry carrying the run it belongs to — with several going at
          // once, an id alone no longer says which card answers it.
          needs: [
            ...live.flatMap((r) => r.pendingAsks().map((a) => ({
              kind: a.kind, id: a.id, runId: r.meta.id, text: a.text,
              options: a.options, toolName: a.toolName, since: a.since,
            }))),
            ...(plannerAsk ? [{
              // No runId: the planner is the project's, not a mission's.
              kind: 'planner' as const, id: plannerAsk.id,
              text: plannerAsk.questions[0]?.question ?? 'The planner is asking',
              options: plannerAsk.questions[0]?.options.map((o) => o.label),
              since: plannerAsk.askedAt,
            }] : []),
          ],
        };
      }));
      json(res, 200, {
        // Billing mode travels with every fleet poll so the UI can state it
        // plainly wherever money is about to be spent.
        firstRun,
        authMode: auth.mode,
        authSource: auth.source,
        authAccount: auth.account ?? null,
        version: currentVersion(),
        update: updateInfo?.newer ? { latest: updateInfo.latest } : null,
        projects: cards.sort(fleetOrder),
      });

    } else if (req.method === 'POST' && url.pathname === '/projects') {
      const { folder, name, provider: providerIn, claudeConfigDir, claudeExecutable } = await readBody(req);
      const parsed = parseProvider(providerIn);
      if (typeof parsed === 'string') return json(res, 400, { error: parsed });
      if (typeof folder !== 'string' || !folder) return json(res, 400, { error: 'folder is required' });
      if (!path.isAbsolute(folder)) return json(res, 400, { error: `folder must be an absolute path: ${folder}` });
      const st = await stat(folder).catch(() => null);
      if (st && !st.isDirectory()) return json(res, 400, { error: `not a directory: ${folder}` });
      if (!st) await mkdir(folder, { recursive: true });
      // The HTTP shape still speaks "Claude Code install"; storage speaks
      // providers. Translating here keeps the UI working unchanged while the
      // union becomes the only thing written to disk.
      // A provider wins; the older claudeConfigDir/claudeExecutable pair still
      // works and means the same thing, so existing callers keep functioning.
      const pin: ProviderRef | undefined = parsed ?? (
        typeof claudeConfigDir === 'string' || typeof claudeExecutable === 'string'
          ? {
              kind: 'claude-code',
              ...(typeof claudeConfigDir === 'string' ? { configDir: claudeConfigDir } : {}),
              ...(typeof claudeExecutable === 'string' ? { executable: claudeExecutable } : {}),
            }
          : undefined);
      json(res, 200, {
        project: await store.addProject(folder, typeof name === 'string' ? name : undefined, pin),
      });

    } else if (req.method === 'PATCH' && projectMatch) {
      const { name, defaultBudgetUsd, provider: providerIn, claudeConfigDir, claudeExecutable, claudeBilling } =
        await readBody(req);
      const parsedPatch = parseProvider(providerIn);
      if (typeof parsedPatch === 'string') return json(res, 400, { error: parsedPatch });
      // `provider: null` clears the pin outright; the legacy triple below
      // expresses the same thing by going empty.
      const providerCleared = providerIn === null;
      // null clears the pin; undefined leaves it untouched.
      const pinGiven =
        claudeConfigDir !== undefined || claudeExecutable !== undefined || claudeBilling !== undefined;
      const ownLogin = claudeBilling === 'own-login';
      // A billing choice is itself a pin, so clearing needs all three empty.
      const cleared =
        pinGiven && !toPath(claudeConfigDir) && !toPath(claudeExecutable) && !ownLogin;
      const updated = await store.updateProject(projectMatch[1], {
        name: typeof name === 'string' ? name : undefined,
        defaultBudgetUsd: typeof defaultBudgetUsd === 'number' ? defaultBudgetUsd : undefined,
        provider: parsedPatch ?? (providerCleared
          ? null
          : !pinGiven
          ? undefined
          : cleared
            ? null
            : {
                kind: 'claude-code' as const,
                ...(toPath(claudeConfigDir) ? { configDir: toPath(claudeConfigDir)! } : {}),
                ...(toPath(claudeExecutable) ? { executable: toPath(claudeExecutable)! } : {}),
                ...(ownLogin ? { ownLogin: true } : {}),
              }),
      });
      json(res, updated ? 200 : 404, updated ? { project: updated } : { error: 'unknown project' });

    } else if (req.method === 'GET' && url.pathname === '/instances') {
      const [discovered, auth, keychain] = await Promise.all([
        discoverInstances(dirHasCredentials),
        detectAuth(),
        hasKeychainCredentials(),
      ]);
      // Which account each dir is signed in as — the thing that actually
      // distinguishes one install from another.
      const instances = await Promise.all(discovered.map(async (i) => ({
        ...i, account: await readAccount(i.configDir),
      })));
      json(res, 200, {
        serverDefault: defaultInstance(),
        // Auth is process-wide: an API key in the environment outranks every
        // stored login, so the picker must not imply the choice is per-dir.
        authMode: auth.mode,
        authAccount: auth.account ?? null,
        keychainLogin: keychain,
        // Gateways currently up, so "what is Foreman actually using" is one
        // request rather than a guess. Routes only — never a credential.
        gateways: gatewayStatus(),
        // A running local Ollama is offered with no configuration at all; the
        // absence of this key is what "none detected" looks like.
        ollama: await discoverOllama().then((models) =>
          models ? { host: ollamaHost(), models } : null),
        // Presence and sign-in state only — never the token.
        codex: await (async () => {
          const home = codexHome();
          const auth = await readCodexAuth(home).catch(() => null);
          const installed = await stat(path.join(home, 'auth.json')).then(() => true, () => false)
            || await stat(path.join(home, 'config.toml')).then(() => true, () => false);
          return installed ? { home, signedIn: Boolean(auth) } : null;
        })(),
        instances,
      });

    } else if (req.method === 'DELETE' && projectMatch) {
      if (activeByProject.has(projectMatch[1])) {
        return json(res, 409, { error: 'project has an active mission' });
      }
      const removed = await store.removeProject(projectMatch[1]);
      // Its planning conversation goes with it; a proposal for a project
      // that no longer exists once showed up in /status as a bare id.
      if (removed) await store.clearChat(projectMatch[1]).catch(() => {});
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown project' });

    } else if (req.method === 'POST' && url.pathname === '/run') {
      const {
        projectId, mission, budgetUsd, directorModel, workerModel, browserTools,
        directorProviderId, workerProviderId, allowDirty, startedBy, crew,
      } = await readBody(req);
      if (typeof projectId !== 'string' || typeof mission !== 'string' || !mission.trim()) {
        return json(res, 400, { error: 'projectId and mission are required' });
      }
      const project = await store.getProject(projectId);
      if (!project) return json(res, 404, { error: 'unknown project' });
      await mkdir(project.folder, { recursive: true });
      // A mission on its own branch takes the working tree with it: `checkout
      // -b` carries uncommitted work onto the mission branch, and the closing
      // commit sweeps whatever is left into the mission's own commit, under
      // the mission's name. So a dirty checkout is refused here rather than
      // quietly absorbed — with an override, because it is the human's tree
      // and their call. Only this route refuses: a mission started from the
      // phone has nobody standing at the keyboard to answer, and gets the
      // warning in its transcript instead.
      // A worktree project is exempt: the mission gets a checkout of its own,
      // made from the default branch, and never touches this one — so whatever
      // is uncommitted here is the human's own business and not the mission's.
      const isoGuard = await isolationFor(project);
      {
        const s = await effectiveSettings(projectId);
        if (s.gitBranchPerMission && allowDirty !== true && isoGuard.isolation !== 'worktree') {
          const info = await gitInfo(project.folder);
          if (info.repo && info.dirty) {
            const files = await dirtyPaths(project.folder);
            return json(res, 409, {
              error: `This checkout has uncommitted changes on ${info.branch ?? 'HEAD'}. `
                + 'They would follow the mission onto its branch and be committed with its work. '
                + 'Commit or stash them first, or start anyway.',
              code: 'dirty-checkout', branch: info.branch ?? null, files,
            });
          }
        }
      }
      // Reservation is the last step before dispatch — no awaits in between.
      const reserved = reserveProject(projectId, { ...isoGuard, projectName: project.name });
      if ('error' in reserved) {
        return json(res, 409, { error: reserved.error });
      }
      const budget = Number(budgetUsd) > 0 ? Number(budgetUsd) : project.defaultBudgetUsd;
      dispatch(projectId, reserved.ticket, startRun(projectId, reserved.ticket, isoGuard.isolation, project.folder, mission, budget,
        modelChoice(directorModel), modelChoice(workerModel), browserTools === true,
        providerOf(project),
        {
          director: typeof directorProviderId === 'string' ? directorProviderId : undefined,
          worker: typeof workerProviderId === 'string' ? workerProviderId : undefined,
        },
        // 'schedule' is deliberately not accepted here: a caller must not be
        // able to forge a scheduled start and charge the month's unattended
        // allowance for a run no schedule asked for.
        { startedBy: startedBy === 'phone' || startedBy === 'mcp' ? startedBy : 'human' },
        // The composer is the only place a crew is chosen, so it is the only
        // dispatch path that carries one; unknown ids are dropped downstream.
        Array.isArray(crew) ? crew as string[] : undefined));
      json(res, 200, { ok: true });

    } else if (url.pathname === '/notify' && req.method === 'GET') {
      // Status, never the token. Mirrors the provider-key rule: the API says
      // whether a token exists and who is linked, and cannot read either out.
      const s = await notifySettings();
      json(res, 200, {
        publicUrl: s.publicUrl,
        prefs: s.prefs,
        active: notifyHub.active,
        delivered: notifyHub.delivered,
        failures: notifyHub.failures,
        telegram: {
          hasToken: await hasSecret(store.root, 'telegram'),
          bot: s.telegramBot ?? null,
          chatId: s.telegramChatId ? `…${s.telegramChatId.slice(-4)}` : null,
          chatLabel: s.telegramChatLabel ?? null,
          linking: telegramLink ? {
            code: telegramLink.code, startedAt: telegramLink.startedAt,
            // Opens the bot with /start <code> pre-filled: the QR below and
            // the "Open in Telegram" link both carry this.
            deepLink: s.telegramBot ? telegramStartLink(s.telegramBot, telegramLink.code) : undefined,
          } : null,
        },
      });

    } else if (url.pathname === '/notify/telegram/qr.svg' && req.method === 'GET') {
      // The deep link as a QR, only while a linking attempt is open — the code
      // is single-use and expires, so there is nothing to render otherwise.
      const s = await notifySettings();
      if (!telegramLink || !s.telegramBot) return json(res, 404, { error: 'no linking attempt in progress' });
      const svg = await QRCode.toString(telegramStartLink(s.telegramBot, telegramLink.code), {
        type: 'svg', margin: 1, errorCorrectionLevel: 'M',
      });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(svg);

    } else if (url.pathname === '/notify/telegram/token') {
      // Write-only, like a provider key. Validated with getMe so a typo is
      // caught here rather than as a silently dead channel later.
      if (req.method === 'PUT') {
        const { token } = await readBody(req);
        const value = typeof token === 'string' ? token.trim() : '';
        if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) return json(res, 400, { error: 'that does not look like a bot token' });
        const me = await getMe(value);
        if (!me) return json(res, 400, { error: 'Telegram rejected the token (or is unreachable)' });
        await putSecret(store.root, 'telegram', value);
        await patchGlobalSettings({ telegramBot: `@${me.username}` });
        await reattachTelegram();
        json(res, 200, { ok: true, bot: `@${me.username}` });
      } else if (req.method === 'DELETE') {
        telegramLink?.abort(); telegramLink = null;
        await deleteSecret(store.root, 'telegram');
        await patchGlobalSettings({ telegramBot: undefined, telegramChatId: undefined, telegramChatLabel: undefined });
        notifyHub.detach('telegram');
        void telegramBot?.stop(); telegramBot = null;
        json(res, 200, { ok: true });
      } else {
        json(res, 405, { error: 'method not allowed' });
      }

    } else if (url.pathname === '/notify/telegram/link') {
      if (req.method === 'POST') {
        const token = await getSecret(store.root, 'telegram');
        if (!token) return json(res, 409, { error: 'store a bot token first' });
        if (!telegramBot) await reattachTelegram();
        if (!telegramBot) return json(res, 409, { error: 'could not start the Telegram reader' });
        telegramLink?.abort();
        const code = linkCode();
        const link = telegramBot.link(code);
        telegramLink = { code, abort: link.abort, startedAt: Date.now() };
        // Resolves in the background; the UI polls GET /notify for the result.
        void link.done.then(async (chat) => {
          if (telegramLink?.code === code) telegramLink = null;
          if (!chat) return;
          await patchGlobalSettings({ telegramChatId: chat.chatId, telegramChatLabel: chat.label });
          if (await reattachTelegram()) {
            void notifyHub.say('<b>Foreman linked.</b> Approvals, questions and finished missions will arrive here.');
          }
        });
        json(res, 200, { ok: true, code, command: `/start ${code}` });
      } else if (req.method === 'DELETE') {
        telegramLink?.abort(); telegramLink = null;
        await patchGlobalSettings({ telegramChatId: undefined, telegramChatLabel: undefined });
        notifyHub.detach('telegram');
        json(res, 200, { ok: true });
      } else {
        json(res, 405, { error: 'method not allowed' });
      }

    } else if (url.pathname === '/notify/test' && req.method === 'POST') {
      const ok = await notifyHub.say('<b>Test from Foreman.</b> This is where you will hear about approvals, stalls and finished missions.');
      json(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'no linked channel, or delivery failed' });

    } else if (url.pathname === '/notify/settings' && req.method === 'PATCH') {
      // The one setting that lives here rather than in the general Settings
      // payload: where deep links point. A phone cannot open localhost.
      const { publicUrl } = await readBody(req);
      if (typeof publicUrl !== 'string') return json(res, 400, { error: 'publicUrl is required' });
      const v = publicUrl.trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\/[^\s/]+/.test(v)) return json(res, 400, { error: 'publicUrl must be an http(s) URL' });
      await patchGlobalSettings({ publicUrl: v || undefined });
      json(res, 200, { ok: true, publicUrl: v || `http://localhost:${PORT}` });

    } else if (providerKeyMatch) {
      // Write-only by design: there is no GET. The API can say whether a key
      // exists — which Settings needs to render its state — and never what it
      // is, so a compromised browser session can replace a key but not read
      // one out.
      const providerId = providerKeyMatch[1];
      if (req.method === 'PUT') {
        const { key } = await readBody(req);
        const value = typeof key === 'string' ? key.trim() : '';
        if (!value) return json(res, 400, { error: 'key is required' });
        await putSecret(store.root, providerId, value);
        json(res, 200, { ok: true, hasKey: true });
      } else if (req.method === 'DELETE') {
        await deleteSecret(store.root, providerId);
        json(res, 200, { ok: true, hasKey: false });
      } else {
        json(res, 405, { error: 'method not allowed' });
      }

    } else if (url.pathname === '/chat') {
      const projectId = req.method === 'POST'
        ? undefined : url.searchParams.get('projectId') ?? '';

      if (req.method === 'GET') {
        if (!projectId) return json(res, 400, { error: 'projectId is required' });
        const [meta, events] = await Promise.all([
          chatMetaOf(projectId),
          store.readChatEvents(projectId).catch(() => []),
        ]);
        // Who answers here, for the bar's footer before any turn has run.
        // Best-effort: a project whose provider cannot resolve still gets its
        // transcript, and the first turn will say what went wrong.
        // The fleet planner's conversation answers on the same route: same
        // log shape, same hook in the UI, its own idea of who answers and
        // whether a reply is in flight.
        if (projectId === FLEET_CHAT_ID) {
          const g = (await store.readSettings().catch(() => ({ global: {}, projects: {} }))).global as Record<string, unknown>;
          const resolvedFleet = await resolveProvider(providerOf({}), store.root).catch(() => null);
          return json(res, 200, {
            events, costUsd: meta.costUsd, proposal: null, thinking: Boolean(fleetAbort), question: null,
            who: resolvedFleet ? {
              model: modelChoice(g.fleetPlannerModel ?? g.plannerModel) || DEFAULT_FLEET_MODEL,
              provider: resolvedFleet.label, costBasis: resolvedFleet.costBasis,
            } : null,
          });
        }
        const project = await store.getProject(projectId);
        const settings = await effectiveSettings(projectId).catch(() => null);
        const resolved = project
          ? await resolveProvider(providerOf(project), store.root).catch(() => null) : null;
        json(res, 200, {
          events,
          costUsd: meta.costUsd,
          proposal: meta.proposal ?? null,
          // A turn in flight is server state, not log state: a client that
          // loads mid-turn needs to know a reply is already on its way.
          thinking: chatTurns.has(projectId),
          // Likewise a question the planner is parked on — it lives in the
          // turn, not the log, and a reload must put the picker back.
          question: pendingChatQuestion(projectId),
          who: resolved ? {
            model: settings?.plannerModel || DEFAULT_PLANNER_MODEL,
            provider: resolved.label,
            costBasis: resolved.costBasis,
          } : null,
        });

      } else if (req.method === 'DELETE') {
        if (!projectId) return json(res, 400, { error: 'projectId is required' });
        if (chatTurns.has(projectId) || (projectId === FLEET_CHAT_ID && fleetAbort)) {
          return json(res, 409, { error: 'the planner is mid-reply — wait for it to finish' });
        }
        await store.clearChat(projectId).catch(() => {});
        broadcastChat(projectId, 'chat_cleared', {});
        json(res, 200, { ok: true });

      } else if (req.method === 'POST') {
        const { projectId: id, text } = await readBody(req);
        const message = typeof text === 'string' ? text.trim() : '';
        if (typeof id !== 'string' || !message) {
          return json(res, 400, { error: 'projectId and text are required' });
        }
        if (id === FLEET_CHAT_ID) {
          // The front desk from the fleet page. The reply streams on the
          // chat frames like a project planner's; the POST returns at once.
          if (fleetAbort) return json(res, 409, { error: 'the fleet planner is still replying' });
          void driveFleetTurn(message, 'http');
          return json(res, 200, { ok: true });
        }
        const project = await store.getProject(id);
        if (!project) return json(res, 404, { error: 'unknown project' });
        // While a mission runs, the director is who you talk to — the same
        // input box becomes the steer bar. Planning stays an idle-only act,
        // which is what keeps "one active mission per project" honest.
        if (activeByProject.has(id)) {
          return json(res, 409, { error: 'this project has a mission running — steer the director instead' });
        }
        // A turn parked on a question is still a turn — but a human who types
        // instead of clicking is answering, not starting a new message. Route
        // the text to the waiting question rather than refusing it: the
        // picker's "something else" and the plain input box should mean the
        // same thing.
        const pending = pendingChatQuestion(id);
        if (pending) {
          const first = pending.questions[0]?.question ?? 'answer';
          const emit = makeChatEmitter(id);
          emit('chat_message', { text: message });
          if (answerChatQuestion(id, pending.id, { [first]: message })) {
            emit('chat_answered', { id: pending.id, answers: { [first]: message } });
          }
          return json(res, 200, { ok: true, answered: pending.id });
        }
        // Check-and-set with no await in between, like reserveProject.
        if (chatTurns.has(id)) return json(res, 409, { error: 'the planner is still replying' });
        chatTurns.add(id);
        void driveChatTurn(project, message);
        json(res, 200, { ok: true });

      } else {
        json(res, 405, { error: 'method not allowed' });
      }

    } else if (req.method === 'POST' && url.pathname === '/chat/stop') {
      // Stop the reply in flight. The model call is aborted, a question the
      // planner was parked on is dropped, and the turn closes on the record
      // with a line saying it was stopped. The conversation stays usable.
      const { projectId: id } = await readBody(req);
      if (typeof id !== 'string') return json(res, 400, { error: 'projectId is required' });
      if (id === FLEET_CHAT_ID) {
        const was = Boolean(fleetAbort);
        fleetAbort?.abort();
        return json(res, 200, { ok: true, stopped: was });
      }
      const abort = chatAborts.get(id);
      if (!abort) return json(res, 200, { ok: true, stopped: false });
      dropPendingAsk(id);
      abort.abort();
      json(res, 200, { ok: true, stopped: true });

    } else if (req.method === 'POST' && url.pathname === '/attachments') {
      // Files for a message — to the planner or in a mission brief. Saved
      // into the project folder so whoever reads the message can read them
      // too; the client appends the returned paths to its text.
      const { projectId: id, files } = await readBody(req);
      if (typeof id !== 'string') return json(res, 400, { error: 'projectId is required' });
      const project = await store.getProject(id);
      if (!project) return json(res, 404, { error: 'unknown project' });
      try {
        const saved = await saveAttachments(project.folder, files as Parameters<typeof saveAttachments>[1]);
        json(res, 200, { files: saved });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }

    } else if (req.method === 'POST' && url.pathname === '/chat/fork') {
      // "Plan the next step": a new planning conversation seeded with a
      // finished run — its brief, its mission doc, the director's report.
      // A fork, not a continuation: the old run stays what it was, and what
      // comes out is a fresh mission with its own budget and baseline.
      const { projectId: id, runId } = await readBody(req);
      if (typeof id !== 'string' || typeof runId !== 'string') {
        return json(res, 400, { error: 'projectId and runId are required' });
      }
      const project = await store.getProject(id);
      if (!project) return json(res, 404, { error: 'unknown project' });
      const meta = await store.readMeta(runId);
      // Owned by projectId, not by folder: a worktree run's folder is its own
      // checkout under FOREMAN_HOME, so a folder test 404s every isolated
      // mission the human tries to plan the next step from.
      if (!meta || !runsOfProject([meta], project).length) return json(res, 404, { error: 'unknown run for this project' });
      if (meta.status === 'running' || activeByProject.has(id)) {
        return json(res, 409, { error: 'that mission is still running — plan its next step once it has ended' });
      }
      if (chatTurns.has(id)) return json(res, 409, { error: 'the planner is mid-reply — wait for it to finish' });
      const [missionDoc, events] = await Promise.all([
        readFile(path.join(meta.folder, '.foreman', 'MISSION.md'), 'utf8').catch(() => null),
        store.readEvents(runId).catch(() => []),
      ]);
      // The director's closing words: the last SDK result message it produced.
      let report: string | null = null;
      for (const e of events) {
        const d = e.data as { agent?: string; msg?: { type?: string; result?: unknown } } | undefined;
        if (e.event === 'message' && d?.agent === 'director' && d.msg?.type === 'result' && typeof d.msg.result === 'string') {
          report = d.msg.result;
        }
      }
      const seed = forkSeed({
        title: meta.title, mission: meta.mission, status: meta.status, endedAt: meta.endedAt,
        missionDoc, report,
      });
      // The seed opens a new conversation. Folding it into an old session
      // would hand the planner two contexts at once; the transcript keeps
      // the fork's own opening line as the human's message.
      chatTurns.add(id);
      await store.clearChat(id).catch(() => {});
      // Every open tab drops the old conversation — proposal card included —
      // before the seeded one starts arriving. Without this a second fork
      // left the previous proposal on screen above the new question.
      broadcastChat(id, 'chat_cleared', {});
      void driveChatTurn(project, seed.prompt, seed.shown);
      json(res, 200, { ok: true });

    } else if (req.method === 'POST' && url.pathname === '/chat/answer') {
      // The picker's answer to a planner ask_user. Resolves the tool call that
      // is blocking the turn; the transcript records what was chosen so a
      // reload shows the decision, not just the question.
      const { projectId: id, id: questionId, answers } = await readBody(req);
      if (typeof id !== 'string' || typeof questionId !== 'string' || !answers || typeof answers !== 'object') {
        return json(res, 400, { error: 'projectId, id and answers are required' });
      }
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
        if (typeof v === 'string') clean[k] = v.slice(0, 2000);
      }
      if (!answerChatQuestion(id, questionId, clean)) {
        return json(res, 404, { error: 'no question waiting under that id — it may have timed out' });
      }
      makeChatEmitter(id)('chat_answered', { id: questionId, answers: clean });
      json(res, 200, { ok: true });

    } else if (req.method === 'POST' && url.pathname === '/permission') {
      const { id, behavior, message } = await readBody(req);
      const valid = behavior === 'allow' || behavior === 'allow_always' || behavior === 'deny';
      if (typeof id !== 'string' || !valid) return json(res, 400, { error: 'invalid request' });
      // Approval ids are globally unique (tool-use ids); find the owning run.
      const ok = activeRuns().some((r) =>
        r.resolvePermission(id, behavior, message as string | undefined));
      if (!ok) return json(res, 404, { error: 'no pending permission with that id' });
      json(res, 200, { ok: true });

    } else if (req.method === 'POST' && url.pathname === '/answer') {
      const { id, text } = await readBody(req);
      if (typeof id !== 'string') return json(res, 400, { error: 'invalid request' });
      const ok = activeRuns().some((r) => r.answerQuestion(id, String(text ?? '')));
      if (!ok) return json(res, 404, { error: 'no pending question with that id' });
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && url.pathname === '/projects/clone/where') {
      // Where a URL would land, before anyone clicks: the dialog shows the
      // path as you type, and the same check refuses what the clone would.
      const repo = (url.searchParams.get('url') ?? '').trim();
      if (!repo) return json(res, 200, { dest: null });
      const where = await cloneDestination(repo);
      json(res, 200, where.ok ? { dest: where.dest, name: where.ref.name, host: where.ref.host } : { dest: null, error: where.error });

    } else if (req.method === 'POST' && url.pathname === '/projects/clone') {
      // Start a clone under the projects root; the picker polls the job.
      const { url: repo, branch } = await readBody(req);
      if (typeof repo !== 'string' || !repo.trim()) return json(res, 400, { error: 'url is required' });
      const where = await cloneDestination(repo.trim());
      if (!where.ok) return json(res, 400, { error: where.error });
      const job: CloneJob = { id: crypto.randomBytes(6).toString('hex'), url: where.ref.url, dest: where.dest, startedAt: Date.now(), state: 'running', progress: 'Starting git…' };
      cloneJobs.set(job.id, job);
      void (async () => {
        const failed = await cloneRepo({ ref: where.ref, dest: where.dest, branch: typeof branch === 'string' && branch.trim() ? branch.trim() : undefined, onProgress: (l) => { job.progress = l; } });
        if (failed) {
          await rm(where.dest, { recursive: true, force: true }).catch(() => {});
          job.state = 'error'; job.error = failed;
        } else {
          const project = await store.addProject(where.dest);
          projectsCache.set(project.id, { name: project.name });
          job.state = 'done'; job.projectId = project.id; job.progress = 'Done';
        }
        // Finished jobs linger long enough to be read, then go.
        setTimeout(() => cloneJobs.delete(job.id), 10 * 60_000).unref();
      })();
      json(res, 202, { id: job.id, dest: job.dest });

    } else if (req.method === 'GET' && /^\/projects\/clone\/[a-f0-9]{12}$/.test(url.pathname)) {
      const job = cloneJobs.get(url.pathname.split('/').pop()!);
      if (!job) return json(res, 404, { error: 'no such clone (Foreman may have restarted; check the projects root)' });
      json(res, 200, { state: job.state, progress: job.progress, projectId: job.projectId, error: job.error, dest: job.dest });

    } else if (req.method === 'GET' && url.pathname === '/search') {
      // Every run across the fleet whose title, brief, project or folder
      // says the words. Run records are small and already on disk; no index.
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (q.length < 2) return json(res, 200, { runs: [] });
      const [runs, projects] = await Promise.all([store.listRuns(), store.listProjects()]);
      const byId = new Map(projects.map((p) => [p.id, p]));
      const byFolder = new Map(projects.map((p) => [p.folder, p]));
      // runsOfProject's rule, as a lookup: the owner is `projectId`, and the
      // folder answers only for runs that predate it. By folder alone every
      // worktree run is nameless here — its folder is its own checkout under
      // FOREMAN_HOME — so it could not be found by its project's name and was
      // listed under a run id.
      const projectOf = (r: RunMeta) => (r.projectId ? byId.get(r.projectId) : byFolder.get(r.folder));
      const hits = runs.filter((r) => {
        const project = projectOf(r);
        return [r.title, r.mission, r.folder, project?.name].some((f) => f?.toLowerCase().includes(q));
      }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map((r) => {
        const project = projectOf(r);
        return {
          id: r.id, projectId: r.projectId ?? project?.id ?? null, projectName: project?.name ?? path.basename(r.folder),
          folder: r.folder, title: r.title, mission: firstLine(r.mission), status: r.status,
          createdAt: r.createdAt, endedAt: r.endedAt, costUsd: r.costUsd, costBasis: costBasisOf(r),
        };
      });
      json(res, 200, { runs: hits });

    } else if (req.method === 'POST' && url.pathname === '/fleet/chat') {
      // One turn at the front desk, answered in the response. The same
      // session the phone uses, so a conversation can move between them.
      const { text } = await readBody(req);
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) return json(res, 400, { error: 'text is required' });
      const r = await driveFleetTurn(trimmed, 'http');
      if (r.busy) return json(res, 409, { error: 'the fleet planner is still replying' });
      json(res, 200, r);

    } else if (req.method === 'POST' && url.pathname === '/fleet/stop') {
      if (!fleetAbort) return json(res, 404, { error: 'no fleet planner reply in flight' });
      fleetAbort.abort();
      json(res, 200, { ok: true });

    } else if (req.method === 'DELETE' && url.pathname === '/fleet/chat') {
      if (fleetAbort) return json(res, 409, { error: 'the fleet planner is mid-reply — stop it first' });
      await store.clearChat(FLEET_CHAT_ID).catch(() => {});
      broadcastChat(FLEET_CHAT_ID, 'chat_cleared', {});
      json(res, 200, { ok: true });

    } else if (runServicesMatch && req.method === 'GET') {
      // What this run exposed, and what of it is still up. Asked after a run
      // ends as much as during it: a finished mission leaves no agent behind
      // to tidy, so the human needs somewhere to see the leftovers.
      const meta = await store.readMeta(runServicesMatch[1]).catch(() => null);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      const list = await Promise.all((meta.services ?? []).map(async (s) => {
        const holder = await listeningPid(s.port);
        return {
          port: s.port, label: s.label, since: s.since, path: s.path,
          listening: holder !== null,
          // Only a process Foreman watched start is one it will offer to stop.
          ours: holder !== null && s.pid !== undefined && holder === s.pid,
        };
      }));
      json(res, 200, { runId: meta.id, status: meta.status, services: list });

    } else if (stopServiceMatch && req.method === 'POST') {
      const meta = await store.readMeta(stopServiceMatch[1]).catch(() => null);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      const port = Number(stopServiceMatch[2]);
      const svc = (meta.services ?? []).find((s) => s.port === port);
      if (!svc) return json(res, 404, { error: 'this run did not expose that port' });
      const r = await stopService(port, svc.pid);
      if (!r.ok) return json(res, 409, { error: r.reason });
      json(res, 200, { ok: true, how: r.how });

    } else if (worktreeRemoveMatch && req.method === 'POST') {
      // Remove a finished mission's worktree, from the run page. Every question
      // that could make this a destructive mistake is answered by
      // worktreeRemoval() in src/isolation.ts, and it is the ONLY way this route
      // reaches a delete: no recorded worktree, a live run, or a path outside
      // `<FOREMAN_HOME>/worktrees` each refuse rather than guess. `force`
      // answers its one warning — unmerged work is the human's to discard.
      const meta = await store.readMeta(worktreeRemoveMatch[1]).catch(() => null);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      const { force } = await readBody(req).catch(() => ({ force: false }));
      // A run that is reserved but not yet attached is not in activeRuns(), and
      // by this point its record already says 'running' and already names its
      // worktree — so the record is asked too. Deleting the checkout out from
      // under a mission seconds before its first turn is the same accident as
      // deleting it mid-run, and this is the guard in front of a recursive rm.
      const live = meta.status === 'running' || activeRuns().some((r) => r.meta.id === meta.id);
      // "Cannot tell" counts as unmerged: a null from git means the base ref is
      // gone, and reading that as merged would discard work nobody else has.
      const unmerged = meta.git
        ? (await worktreeBranchMerged(meta.worktree?.repo ?? meta.folder, meta.git.branch, meta.git.base)) !== true
        : false;
      const d = worktreeRemoval({
        path: meta.worktree?.path ?? null, foremanHome: store.root, live,
        commits: meta.git?.commits, unmerged,
      });
      if (!d.ok) return json(res, 409, { error: d.reason, code: live ? 'live' : 'blocked' });
      if (d.warn && force !== true) return json(res, 409, { error: d.warn, code: 'unmerged' });
      const wt = meta.worktree!;
      const failed = await removeMissionWorktree(wt.repo, wt.path);
      if (failed) return json(res, 500, { error: failed });
      wt.removedAt = Date.now();
      await store.writeMeta(meta).catch(() => {});
      gitInfoCache.delete(wt.path);
      gitInfoCache.delete(wt.repo);
      makeEmitter(meta.id, meta.projectId ?? '')('git_note', { text: `Removed this mission's worktree at ${wt.path}, at your request.` });
      json(res, 200, { ok: true });

    } else if (prStateMatch && req.method === 'GET') {
      // What became of the run's pull request. A final answer (merged,
      // closed) is written to the run so it is not asked again; open is.
      const meta = await store.readMeta(prStateMatch[1]).catch(() => null);
      if (!meta?.git?.pr) return json(res, 404, { error: 'no pull request on this run' });
      if (meta.git.prState) return json(res, 200, { url: meta.git.pr, state: meta.git.prState, cached: true });
      const s = await pullRequestState(meta.folder, meta.git.pr);
      if (s && s.state !== 'open') {
        meta.git = { ...meta.git, prState: s.state };
        await store.writeMeta(meta).catch(() => {});
      }
      json(res, 200, { url: meta.git.pr, state: s?.state ?? null, mergedAt: s?.mergedAt, number: s?.number });

    } else if (prMatch && req.method === 'GET') {
      // The pull request as Foreman would draft it, for the sheet to edit.
      const meta = await store.readMeta(prMatch[1]).catch(() => null);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      if (!meta.git) return json(res, 409, { error: 'this run had no branch of its own' });
      const gone = worktreeGoneReason(meta);
      if (gone) return json(res, 409, { error: gone, code: 'worktree-removed' });
      const info = await gitInfo(meta.folder);
      if (!info.remote) return json(res, 409, { error: 'the repository has no origin remote to push to' });
      const doc = await readFile(path.join(meta.folder, '.foreman', 'MISSION.md'), 'utf8').catch(() => null);
      const gh = await ghReady();
      // Where the request can actually go, which is not always where the
      // mission was branched from — see resolvePrBase.
      const target = await resolvePrBase(meta.folder, meta.git.base);
      json(res, 200, {
        ...prDraft(meta, doc, meta.reviews), branch: meta.git.branch, base: target.base, commits: meta.git.commits ?? null,
        branchedFrom: meta.git.base, baseFellBack: target.fellBack,
        remote: info.remote, compareUrl: compareUrl(info.remote, target.base, meta.git.branch),
        gh, pr: meta.git.pr ?? null, onBranch: info.branch === meta.git.branch, dirty: Boolean(info.dirty),
      });

    } else if (prMatch && req.method === 'POST') {
      // The one outward-facing act: push the mission's branch and open the
      // pull request — as the user, with their git and gh, on their click.
      // Never from an agent, never from the phone.
      const meta = await store.readMeta(prMatch[1]).catch(() => null);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      if (!meta.git) return json(res, 409, { error: 'this run had no branch of its own' });
      if (meta.status === 'running') return json(res, 409, { error: 'the mission is still running' });
      {
        const gone = worktreeGoneReason(meta);
        if (gone) return json(res, 409, { error: gone, code: 'worktree-removed' });
      }
      const { title, body } = await readBody(req);
      const t = typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null;
      if (!t) return json(res, 400, { error: 'a title is required' });
      const b = typeof body === 'string' ? body : '';
      const info = await gitInfo(meta.folder);
      if (!info.remote) return json(res, 409, { error: 'the repository has no origin remote to push to' });
      const emit = makeEmitter(meta.id, meta.projectId ?? prMatch[1]);
      const pushed = await pushBranch(meta.folder, meta.git.branch);
      if (pushed) {
        emit('pull_request', { branch: meta.git.branch, error: pushed, text: `Push of ${meta.git.branch} failed: ${pushed}` });
        return json(res, 502, { error: pushed });
      }
      const gh = await ghReady();
      let url: string | undefined;
      let method: 'gh' | 'compare' = 'compare';
      let note: string | undefined;
      const target = await resolvePrBase(meta.folder, meta.git.base);
      if (gh.present && gh.authed && /github\.com/.test(info.remote)) {
        const r = await createPullRequest(meta.folder, { base: target.base, branch: meta.git.branch, title: t, body: b });
        if (r.url) { url = r.url; method = 'gh'; } else note = r.error;
      }
      if (!url) url = compareUrl(info.remote, target.base, meta.git.branch) ?? undefined;
      meta.git = { ...meta.git, pr: method === 'gh' ? url : meta.git.pr };
      await store.writeMeta(meta).catch(() => {});
      gitInfoCache.delete(meta.folder);
      const text = method === 'gh'
        ? `Pushed ${meta.git.branch} and opened a pull request: ${url}`
        : `Pushed ${meta.git.branch}.${note ? ` ${note}.` : ''} Finish the pull request in the browser: ${url ?? 'open the repository'}`;
      emit('pull_request', {
        branch: meta.git.branch, base: target.base, url, method,
        text: target.fellBack
          ? `${text} (targeting ${target.base}: this mission was branched from ${meta.git.base}, which is not on the remote)`
          : text,
      });
      json(res, 200, { ok: true, url, method, pushed: true, note });

    } else if (req.method === 'POST' && url.pathname === '/steer') {
      const { runId, text } = await readBody(req);
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (typeof runId !== 'string' || !trimmed) return json(res, 400, { error: 'invalid request' });
      const run = activeRuns().find((r) => r.meta.id === runId);
      if (!run) return json(res, 404, { error: 'no active run with that id' });
      if (!run.steer(trimmed)) return json(res, 409, { error: 'run is no longer accepting steers' });
      json(res, 200, { ok: true });

    } else if (req.method === 'PATCH' && url.pathname === '/run') {
      // Change a live mission's settings. Deliberately only the two that
      // genuinely bind mid-run — see MissionRun.applySettings(). A field that
      // needs a restart belongs on the resume path, not here, because a
      // setting that silently does nothing until some later event is worse
      // than one the UI never offered.
      const { runId, browserTools, budgetUsd } = await readBody(req);
      const run = activeRuns().find((r) => r.meta.id === runId);
      if (!run) return json(res, 404, { error: 'no active run with that id' });
      const patch: { browserTools?: boolean; budgetUsd?: number } = {};
      if (typeof browserTools === 'boolean') patch.browserTools = browserTools;
      if (typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd >= 0) {
        patch.budgetUsd = budgetUsd;
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to change' });
      const changes = run.applySettings(patch);
      await store.writeMeta(run.meta).catch(() => {});
      json(res, 200, { ok: true, changes });

    } else if (req.method === 'POST' && url.pathname === '/interrupt') {
      const { runId } = await readBody(req);
      const run = activeRuns().find((r) => r.meta.id === runId);
      if (!run) return json(res, 404, { error: 'no active run with that id' });
      await run.interrupt();
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && url.pathname === '/runs') {
      const projectId = url.searchParams.get('projectId');
      const runs = await store.listRuns();
      json(res, 200, { runs: projectId ? runs.filter((r) => r.projectId === projectId) : runs });

    } else if (req.method === 'POST' && runResumeMatch) {
      const meta = await store.readMeta(runResumeMatch[1]).catch(() => null);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      // Resume already re-reads Settings; an explicit patch rides along for
      // the things that are per-run rather than per-project. Browser tools
      // matter here specifically: PATCH /run reaches future workers, but the
      // director keeps the tool set its own query() opened with, so a resume
      // is the only point at which the DIRECTOR can gain a browser.
      const resumeBody: Record<string, unknown> = await readBody(req).catch(() => ({}));
      if (typeof resumeBody.browserTools === 'boolean') {
        meta.browserTools = resumeBody.browserTools || undefined;
      }
      if (meta.status === 'running' || meta.status === 'done') {
        return json(res, 409, { error: `run is ${meta.status}; only interrupted or failed runs can resume` });
      }
      if (!meta.directorSessionId) {
        return json(res, 409, { error: 'run has no director session to resume' });
      }
      const project = meta.projectId ? await store.getProject(meta.projectId) : null;
      if (!project) {
        return json(res, 409, { error: 'run has no linked project' });
      }
      // A worktree that is gone refuses the resume outright rather than
      // continuing in the project's checkout; the status stays what it was, so
      // the run can be resumed later once the worktree is back.
      const noWorktree = await worktreeResumeRefusal(meta);
      if (noWorktree) return json(res, 409, { error: noWorktree, code: 'worktree-missing' });
      const iso = await isolationFor(project);
      // Reservation is the last step before dispatch — no awaits in between.
      // The workspace is this run's OWN, not the project's as it stands now: a
      // run recorded before the project was flipped to worktrees still resumes
      // in the project folder, and only one mission at a time may be there.
      const reserved = reserveProject(project.id, {
        ...iso, projectName: project.name,
        workspace: meta.worktree ? 'worktree' : 'shared',
      });
      if ('error' in reserved) {
        return json(res, 409, { error: reserved.error });
      }
      // "Resume on…": models picked for this resume, ahead of Settings. A
      // model without a provider id means the project's own provider.
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const overrides = {
        directorModel: str(resumeBody.directorModel), directorProviderId: str(resumeBody.directorProviderId),
        workerModel: str(resumeBody.workerModel), workerProviderId: str(resumeBody.workerProviderId),
        budgetUsd: typeof resumeBody.budgetUsd === 'number' && Number.isFinite(resumeBody.budgetUsd) && resumeBody.budgetUsd > 0
          ? Math.round(resumeBody.budgetUsd * 100) / 100 : undefined,
      };
      dispatch(project.id, reserved.ticket, resumeRun(project.id, reserved.ticket, meta, overrides));
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && runEventsMatch) {
      const events = await store.readEvents(runEventsMatch[1]).catch(() => null);
      if (!events) return json(res, 404, { error: 'unknown run' });
      json(res, 200, { events });

    } else if (req.method === 'GET' && /^\/projects\/[^/]+\/memory$/.test(url.pathname)) {
      // What the project "believes": .foreman/MEMORY.md, read-only here.
      const project = await store.getProject(url.pathname.split('/')[2]).catch(() => null);
      if (!project) return json(res, 404, { error: 'unknown project' });
      json(res, 200, await readMemory(project.folder));

    } else if (req.method === 'GET' && url.pathname === '/schedules/preview') {
      // The picker's "next three runs". Deliberately the same function the
      // ticker fires from, so what the human is shown and what will actually
      // happen cannot drift apart.
      let cadence: unknown;
      try { cadence = JSON.parse(url.searchParams.get('cadence') ?? ''); }
      catch { return json(res, 400, { error: 'cadence must be a JSON object in the query string' }); }
      const parsed = validateCadence(cadence);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      json(res, 200, { next: nextRuns(parsed.cadence, new Date(), 3).map((d) => d.getTime()) });

    } else if (req.method === 'GET' && projectSchedulesMatch) {
      const projectId = projectSchedulesMatch[1];
      if (!await store.getProject(projectId)) return json(res, 404, { error: 'unknown project' });
      const [schedules, runs, settings] = await Promise.all([
        store.listSchedules(projectId), store.listRuns().catch(() => [] as RunMeta[]), effectiveSettings(projectId),
      ]);
      json(res, 200, {
        schedules,
        monthSpendUsd: monthlyScheduledSpend(runs, projectId, new Date()),
        monthlyCapUsd: settings.scheduledMonthlyCapUsd,
      });

    } else if (req.method === 'POST' && projectSchedulesMatch) {
      const projectId = projectSchedulesMatch[1];
      if (!await store.getProject(projectId)) return json(res, 404, { error: 'unknown project' });
      const parsed = parseScheduleBody(await readBody(req), false);
      if ('error' in parsed) return json(res, 400, { error: parsed.error });
      const f = parsed.fields;
      const schedule = await store.addSchedule({
        projectId,
        name: f.name!, brief: f.brief!, cadence: f.cadence!, budgetUsd: f.budgetUsd!,
        directorModel: f.directorModel, workerModel: f.workerModel,
        directorProviderId: f.directorProviderId, workerProviderId: f.workerProviderId,
        // Enabled unless the caller said otherwise: a schedule nobody switched
        // on is a form somebody filled in and forgot.
        enabled: f.enabled !== false,
        nextRunAt: f.enabled === false ? null : nextRunAtMs(f.cadence!, new Date()),
        consecutiveFailures: 0,
        pausedReason: null,
      });
      scheduleNames.set(schedule.id, schedule.name);
      json(res, 200, { schedule });

    } else if (req.method === 'PUT' && scheduleMatch) {
      const existing = await store.getSchedule(scheduleMatch[1]);
      if (!existing) return json(res, 404, { error: 'unknown schedule' });
      const parsed = parseScheduleBody(await readBody(req), true);
      if ('error' in parsed) return json(res, 400, { error: parsed.error });
      const f = parsed.fields;
      const enabled = f.enabled ?? existing.enabled;
      const patch: Partial<Schedule> = { ...f };
      // A changed cadence is a changed answer to "when next?", counted from
      // now: keeping the old firing time would mean the schedule the human
      // just moved fires one more time on the schedule they moved it off.
      if (f.cadence || f.enabled !== undefined) {
        patch.nextRunAt = enabled && existing.pausedReason === null
          ? nextRunAtMs(f.cadence ?? existing.cadence, new Date())
          : null;
      }
      const schedule = await store.updateSchedule(existing.id, patch);
      if (schedule) scheduleNames.set(schedule.id, schedule.name);
      json(res, 200, { schedule });

    } else if (req.method === 'DELETE' && scheduleMatch) {
      const removed = await store.removeSchedule(scheduleMatch[1]);
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown schedule' });

    } else if (req.method === 'POST' && scheduleActionMatch) {
      const [, scheduleId, action] = scheduleActionMatch;
      const s = await store.getSchedule(scheduleId);
      if (!s) return json(res, 404, { error: 'unknown schedule' });
      if (action === 'pause') {
        json(res, 200, { schedule: await store.updateSchedule(s.id, { pausedReason: 'human', nextRunAt: null }) });

      } else if (action === 'resume') {
        // Resuming is a dashboard act and has no remote equivalent on purpose:
        // whatever paused this — the human, the month's ceiling, two failures
        // in a row — is a thing to look at before it runs unattended again.
        json(res, 200, {
          schedule: await store.updateSchedule(s.id, {
            pausedReason: null,
            consecutiveFailures: 0,
            nextRunAt: s.enabled ? nextRunAtMs(s.cadence, new Date()) : null,
          }),
        });

      } else {
        const project = await store.getProject(s.projectId);
        if (!project) return json(res, 404, { error: 'unknown project' });
        // Allowed even at the monthly ceiling, and not counted against it
        // beforehand: the ceiling governs UNATTENDED spending, and a human
        // pressing a button is by definition not that. The run still carries
        // the scheduleId, so what it costs does count towards the month.
        const iso = await isolationFor(project);
        const reserved = reserveProject(s.projectId, { ...iso, projectName: project.name });
        if ('error' in reserved) {
          return json(res, 409, { error: reserved.error });
        }
        startScheduledRun(s, reserved.ticket, iso.isolation, project, 'human');
        json(res, 200, { ok: true });
      }

    } else if (req.method === 'GET' && url.pathname === '/missiondoc') {
      const runId = url.searchParams.get('run');
      if (!runId) return json(res, 400, { error: 'run parameter is required' });
      const meta = await store.readMeta(runId);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      // A finished run answers with the doc as it ended; only a running run
      // reads the folder, which is the one mission running there right now.
      const frozen = meta.status !== 'running' ? await frozenMissionDoc(store.runDirectory(meta.id)) : null;
      const doc = frozen ?? await readFile(path.join(meta.folder, '.foreman', 'MISSION.md'), 'utf8').catch(() => null);
      json(res, 200, { doc, frozen: frozen !== null });

    } else if (req.method === 'GET' && url.pathname === '/browse') {
      const requested = url.searchParams.get('path') || os.homedir();
      const dir = path.resolve(requested);
      if (!pathPermitted(dir, await browseRoots())) {
        return json(res, 400, { error: 'path outside the folders Foreman may browse' });
      }
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) return json(res, 400, { error: `not a directory: ${dir}` });
      const entries = await readdir(dir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      const parent = path.dirname(dir);
      json(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs });

    } else if (req.method === 'POST' && url.pathname === '/mkdir') {
      const { parent, name } = await readBody(req);
      if (typeof parent !== 'string' || !path.isAbsolute(parent)) {
        return json(res, 400, { error: 'parent must be an absolute path' });
      }
      if (typeof name !== 'string' || !name.trim() || /[/\\]/.test(name) || name.trim().startsWith('.')) {
        return json(res, 400, { error: 'invalid folder name' });
      }
      // The parent is what is being written into, so the parent is what has
      // to be inside the allowed folders.
      if (!pathPermitted(parent, await browseRoots())) {
        return json(res, 400, { error: 'path outside the folders Foreman may browse' });
      }
      const parentSt = await stat(parent).catch(() => null);
      if (!parentSt?.isDirectory()) return json(res, 400, { error: `not a directory: ${parent}` });
      const created = path.join(parent, name.trim());
      await mkdir(created, { recursive: true });
      json(res, 200, { path: created });

    } else if (req.method === 'GET' && url.pathname === '/locate') {
      const name = (url.searchParams.get('name') ?? '').trim();
      if (!name) return json(res, 400, { error: 'name is required' });
      json(res, 200, { matches: await locateFolders(name) });

    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    if (err instanceof BodyError) {
      // The answer goes out before the stream is torn down: destroying the
      // request first makes the client see a connection reset instead of the
      // 413 that explains it. `res.end` has already queued the bytes by the
      // time `req.destroy` stops the sender from writing more.
      json(res, err.status, { error: err.message });
      if (!req.readableEnded) req.destroy();
      return;
    }
    json(res, 500, { error: String(err) });
  }
});

/**
 * The second origin: nothing but the crew's exposed dev servers, guarded the
 * same way as the dashboard. Kept separate so a page an agent wrote cannot
 * reach a single Foreman route from the browser — see src/services.ts.
 */
const servicesServer = http.createServer(servicesHandler({
  registry: services,
  allowed: (req) => requestAllowed(req, { port: SERVICES_PORT, tailnet, bindAll: BIND === 'all' }),
}));
/**
 * Why the services port is not listening, when it is not. A taken port must
 * not take the dashboard down with it (an unhandled 'error' on a server is a
 * crash): it is logged, preflight has already warned, and expose_service
 * tells the crew plainly instead of handing out a URL that answers nothing.
 */
let servicesDown: string | null = null;
servicesServer.on('error', (err: NodeJS.ErrnoException) => {
  servicesDown = `Foreman's services port ${SERVICES_PORT} is not available (${err.code ?? err.message}); set FOREMAN_SERVICES_PORT to a free port and restart to expose dev servers`;
  console.warn(`[services] ${servicesDown}`);
});

// Fail loudly on a misconfigured install before anything else happens.
if (!reportPreflight(await preflight({ port: PORT, servicesPort: SERVICES_PORT, foremanHome: store.root, distDir: DIST_DIR, tailnet }))) {
  process.exit(1);
}

// Reconcile runs orphaned by a previous process before accepting traffic.
const swept = await store.sweepOrphans();
if (swept.length) console.log(`Marked ${swept.length} orphaned run(s) as interrupted:`, swept.join(', '));

/**
 * Worktrees under `<FOREMAN_HOME>/worktrees` whose run record is gone.
 *
 * A run deleted by hand, or a FOREMAN_HOME restored from a backup that predates
 * the run — each leaves a full checkout of somebody's repository that nothing
 * will ever look at again, and no surface that lists it. So the server sweeps
 * them at start. (A crash mid-dispatch is NOT one of these cases: `createRun`
 * writes the run's directory before `git worktree add` is called, so a worktree
 * without a run record cannot be made that way.)
 *
 * "Orphaned" is decided by the run DIRECTORY, not by listRuns(): that call
 * answers `[]` when the runs folder cannot be read and drops any run whose
 * meta.json fails to read or parse, so a transient read failure at boot would
 * make every worktree look orphaned and delete checkouts holding unmerged
 * commits. A directory that is simply there is enough to stay the delete, and
 * the sweep stands down entirely when listRuns() came back empty while
 * worktrees exist — that shape is far likelier a bad read than a fleet whose
 * every run was deleted.
 *
 * Every removal still goes through worktreeRemoval(): this walks directory
 * names, and a name is not a reason to delete a tree. Directory names are the
 * SANITISED ids, so a name that matches no project is treated as a project that
 * is gone — the worst case is a plain `rm` of a path the guard has already
 * confirmed is inside Foreman's own worktrees root, instead of git's tidier
 * removal. Never throws: start-up housekeeping that can fail the boot is worse
 * than a stale directory.
 */
async function pruneOrphanedWorktrees(): Promise<string[]> {
  const root = path.join(store.root, 'worktrees');
  const removed: string[] = [];
  const projectDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (!projectDirs.length) return removed;
  const [runs, projects] = await Promise.all([
    store.listRuns().catch(() => [] as RunMeta[]),
    store.listProjects().catch(() => [] as Project[]),
  ]);
  // There are worktrees but the store lists no runs at all. Either every run
  // record is genuinely gone — in which case one more boot with these
  // directories still here costs nothing — or the runs folder could not be
  // read, in which case sweeping would delete work. Stand down.
  if (!runs.length) return removed;
  const folderOf = new Map(projects.map((p) => [p.id, p.folder]));
  /**
   * Is this directory name a run whose record is gone? Asked of the filesystem
   * rather than of the run list, because this is the guard in front of a
   * recursive delete and the list is allowed to be incomplete. A name that is
   * not a legal run id could never have a directory, so runDirectory() throwing
   * is itself the answer.
   */
  const recordGone = async (runId: string): Promise<boolean> => {
    let dir: string;
    try { dir = store.runDirectory(runId); } catch { return true; }
    return !(await stat(dir).then((s) => s.isDirectory()).catch(() => false));
  };
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const projectDir = path.join(root, pd.name);
    const repo = folderOf.get(pd.name);
    for (const rd of await readdir(projectDir, { withFileTypes: true }).catch(() => [])) {
      if (!rd.isDirectory() || !await recordGone(rd.name)) continue;
      const dir = path.join(projectDir, rd.name);
      if (!worktreeRemoval({ path: dir, foremanHome: store.root, live: false }).ok) continue;
      const failed = repo ? await removeMissionWorktree(repo, dir).catch((e) => String(e)) : null;
      if (failed || !repo) await rm(dir, { recursive: true, force: true }).catch(() => {});
      removed.push(dir);
    }
    // An empty project directory is the last trace of a project nobody runs
    // missions in any more; it goes the same way.
    const left = await readdir(projectDir).catch(() => ['keep']);
    if (!left.length) await rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }
  return removed;
}
void pruneOrphanedWorktrees().then((dirs) => {
  if (dirs.length) console.log(`Removed ${dirs.length} worktree(s) with no run record:`, dirs.join(', '));
}).catch(() => {});

// A stored token and a linked chat survive restarts; the channel comes back
// with the server, without anyone re-linking.
void reattachTelegram();

/**
 * A planning turn that was in flight when the process died left its log
 * ending in "thinking" with no "idle" — and a client replaying that log
 * showed a planner still looking, with Clear waiting for a reply that would
 * never come. Close every such turn on the record, with a line saying why.
 */
async function closeOrphanedChatTurns(): Promise<string[]> {
  const closed: string[] = [];
  for (const id of await store.listChatIds()) {
    const events = await store.readChatEvents(id).catch(() => []);
    let open = false;
    for (const e of events) {
      if (e.event === 'chat_turn') open = (e.data as { state?: string })?.state === 'thinking';
    }
    if (!open) continue;
    const emit = makeChatEmitter(id);
    emit('chat_error', { error: 'Foreman restarted while the planner was replying — send your message again.' });
    emit('chat_turn', { state: 'idle' });
    closed.push(id);
  }
  return closed;
}
void closeOrphanedChatTurns().then((ids) => {
  if (ids.length) console.log(`Closed ${ids.length} planning turn(s) cut off by the last shutdown:`, ids.join(', '));
});

// Services declared by earlier runs are still worth proxying if their
// processes outlived the run; the registry is rebuilt from what was saved.
void store.listRuns().then((runs) => {
  for (const r of runs) for (const s of (r as { services?: Array<{ port: number; label: string; pid?: number }> }).services ?? []) services.register(r.id, s.port, s.label, s.pid);
}).catch(() => {});

if (BIND === 'all') {
  server.listen(PORT, () => console.log(`Foreman listening on http://0.0.0.0:${PORT} (FOREMAN_BIND=all) · services on http://0.0.0.0:${SERVICES_PORT}`));
  servicesServer.listen(SERVICES_PORT);
} else {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Foreman listening on http://localhost:${PORT}${tailnet ? ` · ${tailnetUrl(tailnet, PORT)}` : ''} · services on http://localhost:${SERVICES_PORT}`);
  });
  servicesServer.listen(SERVICES_PORT, '127.0.0.1');
  if (tailnet) {
    // A second listener on the tailnet address, feeding the same handler.
    // Not 0.0.0.0: the café Wi-Fi is not the tailnet.
    const onRequest = server.listeners('request')[0] as http.RequestListener;
    const viaTailnet = http.createServer(onRequest);
    viaTailnet.on('error', (err) => console.warn(`[tailscale] could not listen on ${tailnet.ip}:${PORT} — ${err.message}`));
    viaTailnet.listen(PORT, tailnet.ip);
    // The services port needs the same reach: the human opens those previews
    // from their phone, over the tailnet, like everything else.
    const svcViaTailnet = http.createServer(servicesServer.listeners('request')[0] as http.RequestListener);
    svcViaTailnet.on('error', (err) => console.warn(`[tailscale] could not listen on ${tailnet.ip}:${SERVICES_PORT} — ${err.message}`));
    svcViaTailnet.listen(SERVICES_PORT, tailnet.ip);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { viaTailnet.close(); svcViaTailnet.close(); });
  }
}

// Gateways are children of this process; a hard exit would orphan them holding
// loopback ports. Both signals a terminal or a supervisor sends are handled.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopGateways();
    process.exit(0);
  });
}
