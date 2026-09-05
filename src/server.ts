/**
 * Foreman HTTP server — thin wiring between the browser UI, mission
 * orchestrators, and the run store. No business logic lives here.
 *
 * Concurrency model: many projects may each have at most ONE active mission;
 * missions across projects run concurrently. Every live SSE frame is wrapped
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
 *   POST   /permission           Resolve an approval {id, behavior, message?}
 *   POST   /answer               Answer a director question {id, text}
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
 *   DELETE /chat?projectId=      Forget the conversation and its session
 *   PUT    /providers/{id}/key   Store a provider's key {key}
 *   DELETE /providers/{id}/key   Forget it
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissionRun } from './orchestrator.js';
import {
  DEFAULT_PLANNER_MODEL, answerChatQuestion, pendingChatQuestion, runPlanningTurn,
} from './planner.js';
import { DEFAULT_TOOL_POLICY } from './policy.js';
import { RunStore, newRunId } from './store.js';
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
import { TelegramBot, getMe, linkCode, telegramStartLink, telegramTransport } from './notify/telegram.js';
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
import type {
  ChatMeta, CostBasis, ForemanEvent, ModelChoice, Project, ProviderRef, RunMeta, ToolPolicy,
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

  return { models: out, groups, reachable: true };
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

/** Parses a model choice: a known alias or a full claude-* id; else inherit. */
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'ui', 'dist');
const ROOT_ASSETS = new Set(['/favicon.svg']);

const store = new RunStore(process.env.FOREMAN_HOME || undefined);

/** Detected once: env is immutable for this process, and /projects polls at 3s. */
const authPromise = detectAuth();
/** Active runs by projectId (at most one per project); `null` marks a
 *  reservation taken synchronously before the run object exists. */
const activeByProject = new Map<string, MissionRun | null>();
const sseClients = new Set<http.ServerResponse>();

function activeRuns(): MissionRun[] {
  // Filter out reservation placeholders (see reserveProject).
  return [...activeByProject.values()].filter((r): r is MissionRun => Boolean(r));
}

/** Broadcasts an enveloped frame to live clients and persists the bare event. */
function makeEmitter(runId: string, projectId: string) {
  return (event: string, data: unknown): void => {
    const evt: ForemanEvent = { ts: Date.now(), event, data };
    const frame =
      `event: ${event}\ndata: ${JSON.stringify({ runId, projectId, data })}\n\n`;
    for (const res of sseClients) res.write(frame);
    void store.append(runId, evt);
    // The one place notifications hang off the mission stream. Labels are
    // cached here from the events themselves so a message can name the run
    // without a disk read on the emitter's path.
    const d = (data ?? {}) as Record<string, unknown>;
    if (event === 'run_started' || event === 'run_resumed') {
      runLabelCache.set(runId, { ...runLabelCache.get(runId), mission: String(d.mission ?? '') });
    } else if (event === 'run_titled') {
      runLabelCache.set(runId, { ...runLabelCache.get(runId), title: String(d.title ?? '') });
    }
    if (!projectsCache.has(projectId)) {
      void store.getProject(projectId).then((p) => { if (p) projectsCache.set(projectId, { name: p.name }); });
    }
    notifyHub.handle({ event, runId, projectId, data: d, ts: evt.ts });
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
 * Chat frames carry `chat: true` and no run id, so a UI following the same
 * stream can tell a planning conversation from a mission without guessing.
 */
function makeChatEmitter(projectId: string) {
  return (event: string, data: unknown): void => {
    const evt: ForemanEvent = { ts: Date.now(), event, data };
    const frame =
      `event: ${event}\ndata: ${JSON.stringify({ runId: null, projectId, chat: true, data })}\n\n`;
    for (const res of sseClients) res.write(frame);
    void store.appendChat(projectId, evt);
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
    publicUrl: (str('publicUrl') ?? `http://localhost:${PORT}`).replace(/\/+$/, ''),
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
  const s = notifyCtxCache?.value ?? { prefs: { needsYou: true, done: true, budget: true }, publicUrl: `http://localhost:${PORT}` };
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
  const s = await notifySettings();
  const token = await getSecret(store.root, 'telegram');
  if (!token) { void telegramBot?.stop(); telegramBot = null; return false; }
  if (!telegramBot) {
    telegramBot = new TelegramBot(token, undefined, s.telegramChatId ?? null, {
      // Taps and replies from the linked chat become the same calls the tab
      // makes, through the hub — the channel never learns Foreman's routes.
      onCallback: (data, messageId) => notifyHub.handleCallback(data, messageId),
      onText: (text, replyTo) => notifyHub.handleText(text, replyTo),
    });
    telegramBot.start();
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
  }
});

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
}

/** Reads a project's chat meta, or the empty shape for one never started. */
async function chatMetaOf(projectId: string): Promise<ChatMeta> {
  const now = Date.now();
  return (await store.readChatMeta(projectId).catch(() => null))
    ?? { projectId, costUsd: 0, createdAt: now, updatedAt: now };
}

/**
 * Runs one planning turn: the human's message goes into the log first (so a
 * reload mid-turn still shows what was asked), then the planner's reply
 * streams out through the same envelope machinery as a mission.
 */
async function driveChatTurn(project: Project, text: string): Promise<void> {
  const emit = makeChatEmitter(project.id);
  const meta = await chatMetaOf(project.id);
  emit('chat_message', { text });
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
    const problem = providerProblem(resolved);
    if (problem) {
      emit('chat_error', { error: `provider unavailable — ${problem}` });
      return;
    }
    // What the machine can run, so a recommendation is a real id. Fetched
    // per turn because it is per turn: a provider that came up or went away
    // since the last message changes the answer.
    const { models } = await availableModels(project).catch(() => ({ models: [] }));
    const result = await runPlanningTurn({
      projectId: project.id,
      models: models.map((m) => ({
        id: m.id, label: m.label, providerId: m.providerId,
        providerLabel: m.providerLabel, costBasis: m.costBasis, note: m.note,
      })),
      sessionId: meta.sessionId,
      folder: project.folder,
      text,
      model: settings.plannerModel,
      agentEnv: await agentEnvFor(resolved, `chat:${project.id}`),
      emit,
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
    if (result.error) emit('chat_error', { error: result.error });
  } catch (err) {
    // runPlanningTurn does not throw; anything here is a Foreman bug or a
    // storage failure, and must not take the server down with it.
    console.error(`planning turn failed for project ${project.id}:`, err);
    emit('chat_error', { error: String(err) });
  } finally {
    chatTurns.delete(project.id);
    emit('chat_turn', { state: 'idle' });
  }
}

/**
 * A mission has started, so the proposal that led to it is spent. Recording
 * the handoff in the conversation matters as much as clearing it: the chat is
 * the story of how this mission came to exist, and it should not simply stop
 * at the moment the work began.
 */
async function consumeProposal(projectId: string, runId: string, mission: string): Promise<void> {
  const meta = await store.readChatMeta(projectId).catch(() => null);
  if (!meta) return;
  makeChatEmitter(projectId)('mission_started', { runId, mission });
  if (!meta.proposal) return;
  const { proposal: _spent, ...rest } = meta;
  await store.writeChatMeta({ ...rest, updatedAt: Date.now() }).catch(() => {});
}

/**
 * Reserves a project for a new/resumed mission. Synchronous check-and-set:
 * routes call this AFTER their last await and BEFORE any further await, which
 * makes "one active mission per project" race-free on the single JS thread.
 */
function reserveProject(projectId: string): boolean {
  if (activeByProject.has(projectId)) return false;
  activeByProject.set(projectId, null); // reservation placeholder
  return true;
}

/** Runs a mission to completion. The project must already be reserved. */
async function driveRun(
  projectId: string, meta: RunMeta, resume?: { sessionId?: string },
  changes?: { directorChanged: boolean; workerChanged: boolean },
): Promise<void> {
  const emit = makeEmitter(meta.id, projectId);
  // One resolution per run, from the provider frozen into the run's metadata.
  // A run that cannot resolve a credential must not start: dispatching anyway
  // would fall back to whatever the environment happens to hold.
  const resolved = await resolveProvider(providerOf(meta), store.root);
  const problem = providerProblem(resolved);
  if (problem) {
    meta.status = 'error';
    meta.endedAt = Date.now();
    await store.writeMeta(meta).catch(() => {});
    emit('run_error', { error: `provider unavailable — ${problem}` });
    emit('run_finished', { status: 'error', costUsd: meta.costUsd });
    activeByProject.delete(projectId);
    return;
  }
  let agentEnv;
  let roleBasis = resolved.costBasis;
  let prices: { director?: ModelPrice; worker?: ModelPrice } = {};
  let roleBases: { director: CostBasis; worker: CostBasis } | undefined;
  let gatewayRoles = { director: false, worker: false };
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
    };
    // Only roles that actually go through a gateway are counted there; a
    // native role's tokens arrive on the SDK's own result message, and adding
    // both would double every one of them.
    gatewayRoles = {
      director: directorProvider.wire !== 'anthropic-native',
      worker: workerProvider.wire !== 'anthropic-native',
    };
    const directorCost = await roleCost(directorProvider, meta.directorModel);
    const workerCost = directorProvider === workerProvider && meta.directorModel === meta.workerModel
      ? directorCost
      : await roleCost(workerProvider, meta.workerModel);
    roleBasis = combineBasis(directorCost.basis, workerCost.basis);
    prices = { director: directorCost.price, worker: workerCost.price };
    roleBases = { director: directorCost.basis, worker: workerCost.basis };
  } catch (err) {
    meta.status = 'error';
    meta.endedAt = Date.now();
    await store.writeMeta(meta).catch(() => {});
    emit('run_error', { error: String(err instanceof Error ? err.message : err) });
    emit('run_finished', { status: 'error', costUsd: meta.costUsd });
    activeByProject.delete(projectId);
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
  }, roleBases);
  activeByProject.set(projectId, run);
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
    if (activeByProject.get(projectId) === run) activeByProject.delete(projectId);
  }
}

/** Effective run configuration: defaults ← global Settings ← project overlay. */
async function effectiveSettings(projectId: string): Promise<{
  toolPolicy: ToolPolicy; autoAllowReadOnly: boolean;
  directorModel: ModelChoice; workerModel: ModelChoice; plannerModel: ModelChoice;
  /** Provider serving each role, when Settings pinned one with the model. */
  directorProviderId?: string; workerProviderId?: string;
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
  };
}

async function startRun(
  projectId: string, folder: string, mission: string, budgetUsd: number,
  directorModel: ModelChoice, workerModel: ModelChoice, browserTools: boolean,
  provider: ProviderRef,
  roleProviders: { director?: string; worker?: string } = {},
): Promise<void> {
  const settings = await effectiveSettings(projectId);
  const meta: RunMeta = {
    id: newRunId(),
    projectId,
    folder, mission, budgetUsd,
    // An explicit composer choice wins; "Default" inherits from Settings.
    directorModel: directorModel ?? settings.directorModel,
    workerModel: workerModel ?? settings.workerModel,
    // Which provider serves each role — from the model that was picked, so
    // choosing a model chooses where that role runs.
    directorProviderId: roleProviders.director ?? settings.directorProviderId,
    workerProviderId: roleProviders.worker ?? settings.workerProviderId,
    browserTools: browserTools || undefined,
    toolPolicy: settings.toolPolicy,
    autoAllowReadOnly: settings.autoAllowReadOnly,
    // Frozen at dispatch: a later change to the project or the server default
    // must not silently move an in-flight or resumed run to another provider,
    // or another bill.
    provider,
    status: 'running', costUsd: 0,
    createdAt: Date.now(), workers: [],
  };
  try {
    await store.createRun(meta);
  } catch (err) {
    activeByProject.delete(projectId);
    console.error(`failed to create run for project ${projectId}:`, err);
    return;
  }
  await consumeProposal(projectId, meta.id, mission).catch(() => {});
  await driveRun(projectId, meta);
}

/** Resumes an interrupted run by restoring the director's session. */
async function resumeRun(projectId: string, meta: RunMeta): Promise<void> {
  const sessionId = meta.directorSessionId;
  // Resume re-reads Settings, so changing models or tool policy after a
  // failure takes effect on the retry. A director session cannot switch
  // model mid-session, so a changed director model restarts the session
  // fresh (the mission doc carries the state forward).
  const settings = await effectiveSettings(projectId);
  const directorChanged =
    settings.directorModel !== undefined && settings.directorModel !== meta.directorModel;
  const workerChanged =
    settings.workerModel !== undefined && settings.workerModel !== meta.workerModel;
  if (directorChanged) meta.directorModel = settings.directorModel;
  if (workerChanged) meta.workerModel = settings.workerModel;
  meta.toolPolicy = settings.toolPolicy;
  meta.autoAllowReadOnly = settings.autoAllowReadOnly;
  meta.status = 'running';
  meta.endedAt = undefined;
  meta.resumes = (meta.resumes ?? 0) + 1;
  await store.writeMeta(meta).catch((err) => {
    console.error(`failed to persist resume of ${meta.id}:`, err);
  });
  // Always a resume, even when the model change forces a fresh session.
  await driveRun(projectId, meta, { sessionId: directorChanged ? undefined : sessionId }, {
    directorChanged, workerChanged,
  });
}

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

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>) : {};
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const runEventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
  const runResumeMatch = url.pathname.match(/^\/runs\/([^/]+)\/resume$/);
  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
  const providerKeyMatch = url.pathname.match(/^\/providers\/([A-Za-z0-9_-]{1,64})\/key$/);

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
          next.projects[projectId] = project as Record<string, unknown>;
        } else {
          delete next.projects[projectId];
        }
      }
      await store.writeSettings(next);
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
      const [projects, allRuns, auth] = await Promise.all([
        store.listProjects(), store.listRuns(), authPromise,
      ]);
      const cards = await Promise.all(projects.map(async (p) => {
        const run = activeByProject.get(p.id);
        const plannerAsk = pendingChatQuestion(p.id);
        // Newest finished run for the idle-card summary (runs are newest-first).
        const lastRun = allRuns.find((r) => r.projectId === p.id && r.status !== 'running') ?? null;
        return {
          ...p,
          // What THIS project will actually bill, which can differ from the
          // server's mode when the pin opts out of the inherited key.
          billingMode: await projectBilling(p, auth.mode),
          // Whether a key is on file, never the key. Settings renders
          // "stored / not stored" from this and nothing more.
          providerHasKey: await providerHasKeyOf(p),
          activeRun: run ? { ...run.meta } : null,
          lastRun: lastRun && {
            mission: lastRun.mission, title: lastRun.title, status: lastRun.status,
            createdAt: lastRun.createdAt, costUsd: lastRun.costUsd,
            // The card may print a dollar only where the dollar was real.
            costBasis: costBasisOf(lastRun), usage: lastRun.usage,
          },
          // When this project last did anything, so the fleet can lead with it.
          // A planner parked on a question is doing something — waiting on
          // you — and a never-run project falls back to when it was linked.
          lastActivityAt:
            plannerAsk?.askedAt ?? run?.meta.createdAt ?? lastRun?.endedAt ?? lastRun?.createdAt ?? p.createdAt,
          pendingPermissions: run?.pendingPermissionIds.length ?? 0,
          // A planner question blocks the human exactly as a director's does,
          // so it counts here: the card floats to the top tier and wears the
          // strip. `plannerQuestion` lets the strip say which one it is.
          pendingQuestions: (run?.pendingQuestionIds.length ?? 0) + (plannerAsk ? 1 : 0),
          plannerQuestion: Boolean(plannerAsk),
        };
      }));
      json(res, 200, {
        // Billing mode travels with every fleet poll so the UI can state it
        // plainly wherever money is about to be spent.
        authMode: auth.mode,
        authSource: auth.source,
        authAccount: auth.account ?? null,
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
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown project' });

    } else if (req.method === 'POST' && url.pathname === '/run') {
      const {
        projectId, mission, budgetUsd, directorModel, workerModel, browserTools,
        directorProviderId, workerProviderId,
      } = await readBody(req);
      if (typeof projectId !== 'string' || typeof mission !== 'string' || !mission.trim()) {
        return json(res, 400, { error: 'projectId and mission are required' });
      }
      const project = await store.getProject(projectId);
      if (!project) return json(res, 404, { error: 'unknown project' });
      await mkdir(project.folder, { recursive: true });
      // Reservation is the last step before dispatch — no awaits in between.
      if (!reserveProject(projectId)) {
        return json(res, 409, { error: 'this project already has an active mission' });
      }
      const budget = Number(budgetUsd) > 0 ? Number(budgetUsd) : project.defaultBudgetUsd;
      void startRun(projectId, project.folder, mission, budget,
        modelChoice(directorModel), modelChoice(workerModel), browserTools === true,
        providerOf(project),
        {
          director: typeof directorProviderId === 'string' ? directorProviderId : undefined,
          worker: typeof workerProviderId === 'string' ? workerProviderId : undefined,
        });
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
        if (chatTurns.has(projectId)) {
          return json(res, 409, { error: 'the planner is mid-reply — wait for it to finish' });
        }
        await store.clearChat(projectId).catch(() => {});
        json(res, 200, { ok: true });

      } else if (req.method === 'POST') {
        const { projectId: id, text } = await readBody(req);
        const message = typeof text === 'string' ? text.trim() : '';
        if (typeof id !== 'string' || !message) {
          return json(res, 400, { error: 'projectId and text are required' });
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
      if (!meta.projectId || !(await store.getProject(meta.projectId))) {
        return json(res, 409, { error: 'run has no linked project' });
      }
      // Reservation is the last step before dispatch — no awaits in between.
      if (!reserveProject(meta.projectId)) {
        return json(res, 409, { error: 'this project already has an active mission' });
      }
      void resumeRun(meta.projectId, meta);
      json(res, 200, { ok: true });

    } else if (req.method === 'GET' && runEventsMatch) {
      const events = await store.readEvents(runEventsMatch[1]).catch(() => null);
      if (!events) return json(res, 404, { error: 'unknown run' });
      json(res, 200, { events });

    } else if (req.method === 'GET' && url.pathname === '/missiondoc') {
      const runId = url.searchParams.get('run');
      if (!runId) return json(res, 400, { error: 'run parameter is required' });
      const meta = await store.readMeta(runId);
      if (!meta) return json(res, 404, { error: 'unknown run' });
      const doc = await readFile(path.join(meta.folder, '.foreman', 'MISSION.md'), 'utf8')
        .catch(() => null);
      json(res, 200, { doc });

    } else if (req.method === 'GET' && url.pathname === '/browse') {
      const requested = url.searchParams.get('path') || os.homedir();
      const dir = path.resolve(requested);
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
    json(res, 500, { error: String(err) });
  }
});

// Fail loudly on a misconfigured install before anything else happens.
if (!reportPreflight(await preflight({ port: PORT, foremanHome: store.root, distDir: DIST_DIR }))) {
  process.exit(1);
}

// Reconcile runs orphaned by a previous process before accepting traffic.
const swept = await store.sweepOrphans();
if (swept.length) console.log(`Marked ${swept.length} orphaned run(s) as interrupted:`, swept.join(', '));

// A stored token and a linked chat survive restarts; the channel comes back
// with the server, without anyone re-linking.
void reattachTelegram();

server.listen(PORT, () => {
  console.log(`Foreman listening on http://localhost:${PORT}`);
});

// Gateways are children of this process; a hard exit would orphan them holding
// loopback ports. Both signals a terminal or a supervisor sends are handled.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopGateways();
    process.exit(0);
  });
}
