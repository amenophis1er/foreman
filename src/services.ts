/**
 * Services the crew exposes: a dev server it started to test its work, made
 * reachable through Foreman's machine — so the human on the phone can open it
 * over the tailnet without the agent opening a port to the world.
 *
 * These pages are served on their own port (FOREMAN_SERVICES_PORT, PORT + 1 by
 * default), never on the dashboard's. Whatever the crew wrote runs in a
 * browser, and if it ran on Foreman's origin the same-origin policy would let
 * it call every Foreman API as the operator. A different port is a different
 * origin, so it cannot.
 *
 * The proxy is deliberately narrow. Only ports a run declared, only on
 * loopback, only under `/svc/<run>/<port>/`. Nothing is guessed: a request
 * for an undeclared pair is a 404, a declared service that is down is a 502
 * with a sentence, never a hang.
 */
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import type { GuardVerdict } from './guard.js';

export interface ExposedService {
  port: number;
  label: string;
  /**
   * The process listening on the port when the crew exposed it. Recorded so a
   * stop later can prove it is still the same process — a port is a slot
   * anyone can take, and Foreman must never kill something it did not start.
   */
  pid?: number;
  /** `/svc/<runId>/<port>/` — the path under the services origin, not Foreman's. */
  path: string;
  since: number;
}

export const SVC_PREFIX = '/svc/';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

export function servicePath(runId: string, port: number): string {
  return `${SVC_PREFIX}${encodeURIComponent(runId)}/${port}/`;
}

/** `/svc/<run>/<port>/rest` → its parts, or null. The rest keeps its leading slash. */
export function parseServicePath(pathname: string): { runId: string; port: number; rest: string } | null {
  const m = /^\/svc\/([^/]+)\/(\d{2,5})(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { runId: decodeURIComponent(m[1]), port, rest: m[3] ?? '/' };
}

/** Something is accepting connections on 127.0.0.1:port right now. */
export function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * The pid of whatever is listening on a local port, via lsof. Null when
 * nothing is, or when lsof is unavailable — in which case Foreman simply
 * never offers to stop the service, which is the safe direction.
 */
export async function listeningPid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const pid = Number(String(stdout).split('\n')[0]?.trim());
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/** Is this process still alive? Signal 0 asks without sending anything. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export type StopResult =
  | { ok: true; how: 'term' | 'kill' }
  | { ok: false; reason: string };

/**
 * Stops a service the crew started, and only that one. The pid recorded when
 * it was exposed must still be the process holding the port: if something
 * else took the port since, or the recorded process is gone, this refuses
 * rather than guessing. SIGTERM first, so a dev server gets to clean up.
 */
export async function stopService(port: number, expectedPid: number | undefined, graceMs = 4000): Promise<StopResult> {
  if (!expectedPid) return { ok: false, reason: 'Foreman did not record which process this was, so it will not kill anything.' };
  const holder = await listeningPid(port);
  if (holder === null) return { ok: false, reason: `nothing is listening on 127.0.0.1:${port} any more` };
  if (holder !== expectedPid) {
    return { ok: false, reason: `port ${port} is held by process ${holder} now, not the ${expectedPid} this run started — leaving it alone` };
  }
  try { process.kill(expectedPid, 'SIGTERM'); } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (!alive(expectedPid)) return { ok: true, how: 'term' };
  }
  try { process.kill(expectedPid, 'SIGKILL'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 200));
  return alive(expectedPid)
    ? { ok: false, reason: `process ${expectedPid} did not stop` }
    : { ok: true, how: 'kill' };
}

export class ServiceRegistry {
  private byRun = new Map<string, ExposedService[]>();

  register(runId: string, port: number, label: string, pid?: number): ExposedService {
    const list = this.byRun.get(runId) ?? [];
    const existing = list.find((s) => s.port === port);
    if (existing) { existing.label = label || existing.label; if (pid) existing.pid = pid; return existing; }
    const svc: ExposedService = { port, label: label || `port ${port}`, path: servicePath(runId, port), since: Date.now(), pid };
    this.byRun.set(runId, [...list, svc]);
    return svc;
  }

  list(runId: string): ExposedService[] { return this.byRun.get(runId) ?? []; }

  has(runId: string, port: number): boolean { return this.list(runId).some((s) => s.port === port); }

  /** Which run declared this port, if any — for sub-resource requests that only carry a Referer. */
  runsFor(port: number): string[] {
    return [...this.byRun.entries()].filter(([, l]) => l.some((s) => s.port === port)).map(([id]) => id);
  }
}

/**
 * Streams one request to 127.0.0.1:port and its response back. `rest` is the
 * path the service sees; Foreman's prefix is passed along in a header for
 * apps that know how to honour it.
 */
export function proxyToService(
  req: http.IncomingMessage, res: http.ServerResponse,
  port: number, rest: string, search: string, prefix: string,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = `127.0.0.1:${port}`;
  headers['x-forwarded-prefix'] = prefix;
  headers['x-forwarded-host'] = String(req.headers.host ?? '');
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: rest + search, headers }, (r) => {
    const out: Record<string, string | string[] | number> = {};
    for (const [k, v] of Object.entries(r.headers)) {
      if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
    }
    res.writeHead(r.statusCode ?? 502, out);
    r.pipe(res);
  });
  up.setTimeout(30_000, () => up.destroy(new Error('timeout')));
  up.on('error', (err) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`Nothing is answering on 127.0.0.1:${port} (${err.message}). The service the crew exposed may have stopped with its run.`);
  });
  req.pipe(up);
}

/**
 * The whole of the services port: the guard, the proxy, and nothing else.
 *
 * It is a function of its dependencies rather than a closure over the server's
 * module scope so a test can start one on an ephemeral port with its own
 * registry — importing server.ts would start listening for real. `allowed` is
 * passed in for the same reason: the guard has to be told the port it is
 * defending, which the test only learns after listen().
 */
export function servicesHandler(deps: {
  registry: ServiceRegistry;
  allowed: (req: http.IncomingMessage) => GuardVerdict;
}): http.RequestListener {
  const jsonErr = (res: http.ServerResponse, status: number, error: string) => {
    const body = JSON.stringify({ error });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  return (req, res) => {
    // A DNS-rebound page must not reach the proxy either: it would be talking
    // to the crew's dev server from an origin of the attacker's choosing.
    const verdict = deps.allowed(req);
    if (!verdict.ok) { jsonErr(res, verdict.status, verdict.error); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    // Services the crew exposed: /svc/<run>/<port>/… goes to 127.0.0.1:<port>,
    // but only for a pair a run declared. A page served this way asks for its
    // absolute-path assets (`/app.js`) against this server's root; those arrive
    // as sub-resource requests carrying the service page as Referer, and are
    // routed to the same service. Documents never are — a typed URL is not.
    const svc = parseServicePath(url.pathname);
    if (svc) {
      if (!deps.registry.has(svc.runId, svc.port)) { jsonErr(res, 404, 'no such service'); return; }
      proxyToService(req, res, svc.port, svc.rest, url.search, servicePath(svc.runId, svc.port));
      return;
    }
    const ref = req.headers.referer;
    const dest = String(req.headers['sec-fetch-dest'] ?? '');
    if (ref && dest && dest !== 'document' && dest !== 'empty' && !url.pathname.startsWith(SVC_PREFIX)) {
      try {
        const via = parseServicePath(new URL(ref).pathname);
        if (via && deps.registry.has(via.runId, via.port)) {
          proxyToService(req, res, via.port, url.pathname, url.search, servicePath(via.runId, via.port));
          return;
        }
      } catch { /* not a URL we can read — fall through to the 404 */ }
    }
    jsonErr(res, 404, 'not found');
  };
}
