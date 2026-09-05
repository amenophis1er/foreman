/**
 * Gateway supervisor — one translating proxy per active provider.
 *
 * `src/gateway/llm-gateway.cjs` is a verbatim copy from a sibling project. It
 * takes its upstream and mode from process env and serves one of them, which
 * is right for a container holding a single agent and wrong for Foreman, where
 * one server may run missions for several projects on different providers at
 * once.
 *
 * The answer is a process per provider rather than a router inside the file.
 * That keeps the copy verbatim — its test suite applies unchanged and
 * re-syncing upstream stays a `cp` — and it buys process isolation and a
 * lifecycle that ends when a provider goes idle. See
 * docs/provider-model-tracker.md, Decisions.
 *
 * Nothing here ever sees a credential. The gateway authenticates per request
 * from the header the agent sends, so a running gateway is a route, not a
 * secret: the key travels agent → gateway → upstream and is never in this
 * process's argv, env, or logs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ResolvedProvider } from './provider.js';

const GATEWAY_CLI = fileURLToPath(new URL('./gateway/llm-gateway.cjs', import.meta.url));

/** Give up on a gateway that has not bound its port by then. */
const START_TIMEOUT_MS = 10_000;

/** A gateway unused for this long is shut down. Restarting one costs ~200ms. */
const IDLE_MS = 10 * 60_000;

/** Restarts within this window count toward the crash-loop cutoff. */
const CRASH_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;

interface Gateway {
  key: string;
  port: number;
  mode: 'openai' | 'codex';
  upstream: string;
  child: ChildProcess;
  /** Bumped whenever an agent env is built against this gateway. */
  lastUsed: number;
  restarts: number[];
  /** Set when the gateway has crash-looped; reported instead of restarted. */
  broken?: string;
}

const running = new Map<string, Gateway>();
let reaper: NodeJS.Timeout | null = null;

/**
 * Identity of a gateway. Mode and upstream are all that distinguish one from
 * another — two providers pointing at the same endpoint in the same mode can
 * share, since the credential rides on each request rather than the process.
 */
function keyFor(p: ResolvedProvider): string {
  // Account id is part of the identity for Codex: it is the gateway's fallback
  // when a token carries no account claim, and two logins sharing a process
  // would then borrow the first one's.
  return `${p.wire}|${p.upstreamUrl ?? ''}|${p.accountId ?? ''}`;
}

/** An unused loopback port, chosen by the OS rather than guessed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Resolves once something is listening on the port, or rejects on timeout. */
async function waitForListen(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`gateway exited during startup (code ${child.exitCode ?? child.signalCode})`);
    }
    const up = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(500, () => done(false));
    });
    if (up) return;
    if (Date.now() > deadline) throw new Error(`gateway did not listen on ${port} within ${START_TIMEOUT_MS}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Ensures a gateway is running for this provider and returns its base URL.
 *
 * Called on the dispatch path, so it throws rather than returning a broken
 * URL: a run that cannot reach its gateway must fail with a reason, not send
 * requests into a closed port.
 */
export async function ensureGateway(p: ResolvedProvider): Promise<string> {
  if (p.wire === 'anthropic-native') throw new Error('native providers need no gateway');
  const key = keyFor(p);

  const existing = running.get(key);
  if (existing) {
    if (existing.broken) throw new Error(existing.broken);
    if (existing.child.exitCode === null) {
      existing.lastUsed = Date.now();
      return `http://127.0.0.1:${existing.port}`;
    }
    running.delete(key);
  }

  const mode = p.wire === 'gateway-codex' ? 'codex' as const : 'openai' as const;
  const upstream = p.upstreamUrl ?? '';
  const accountId = p.accountId ?? '';
  const port = await freePort();

  // Only routing goes in the env. LLM_GATEWAY_DEFAULT_MODEL is deliberately
  // absent: the model-alias remap already happens in the agent's own env, and
  // baking a model into a shared process would make it wrong for the next
  // provider that reuses this gateway.
  const child = spawn(process.execPath, [GATEWAY_CLI], {
    env: {
      ...process.env,
      LLM_GATEWAY_MODE: mode,
      LLM_GATEWAY_TARGET_URL: upstream,
      LLM_GATEWAY_PORT: String(port),
      // The ported file defaults this to the name of the project it came from.
      // Foreman says who it actually is: the originator header is a claim
      // about which client is calling, and sending someone else's name — or
      // the CLI's, to look like Codex itself — would be a lie told to a
      // vendor. See provider-model.md §5.
      CODEX_ORIGINATOR: process.env.CODEX_ORIGINATOR || 'foreman',
      // Only consulted when the token carries no account claim of its own.
      ...(accountId ? { CODEX_ACCOUNT_ID: accountId } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.unref();

  const gw: Gateway = { key, port, mode, upstream, child, lastUsed: Date.now(), restarts: [] };
  running.set(key, gw);

  // The gateway logs one line per translated model substitution and its own
  // startup banner. Prefix them so they are attributable in Foreman's output.
  const log = (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim()) console.error(`[gateway ${mode}:${port}] ${line}`);
    }
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', log);

  child.on('exit', (code, signal) => {
    const g = running.get(key);
    if (!g || g.child !== child) return; // already replaced
    const now = Date.now();
    g.restarts = [...g.restarts.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (g.restarts.length > MAX_RESTARTS_PER_WINDOW) {
      // A gateway that dies repeatedly is misconfigured, not unlucky. Report it
      // instead of restarting forever behind a mission that keeps failing.
      g.broken = `gateway for ${upstream || mode} keeps exiting (last: code ${code ?? signal})`;
      console.error(`[gateway] ${g.broken}`);
      return;
    }
    running.delete(key);
  });

  try {
    await waitForListen(port, child);
  } catch (err) {
    child.kill();
    running.delete(key);
    throw new Error(`could not start the gateway: ${String(err instanceof Error ? err.message : err)}`);
  }

  startReaper();
  return `http://127.0.0.1:${port}`;
}

/** Stops gateways nothing has used recently. Cheap to restart on demand. */
function startReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, g] of running) {
      if (now - g.lastUsed < IDLE_MS) continue;
      g.child.kill();
      running.delete(key);
    }
    if (running.size === 0 && reaper) {
      clearInterval(reaper);
      reaper = null;
    }
  }, 60_000);
  reaper.unref();
}

/** Stops every gateway. Called on server shutdown so none are orphaned. */
export function stopGateways(): void {
  for (const [key, g] of running) {
    g.child.kill();
    running.delete(key);
  }
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

/** Running gateways, for preflight and diagnostics. Never includes secrets. */
export function gatewayStatus(): Array<{ mode: string; upstream: string; port: number; broken?: string }> {
  return [...running.values()].map((g) => ({
    mode: g.mode, upstream: g.upstream, port: g.port, broken: g.broken,
  }));
}
