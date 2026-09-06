/**
 * Is this machine on a tailnet, and what is it called there?
 *
 * Foreman has no login. Listening on every interface would put the dashboard
 * on whatever Wi-Fi the laptop joins; listening on loopback alone leaves the
 * phone out. Tailscale is the middle: a private network of the user's own
 * devices, with a stable name. When it is present Foreman listens on it too,
 * and the links it sends to the phone use that name — the phone can open
 * them from anywhere the tailnet reaches.
 *
 * Detection is read-only and best-effort: the CLI's `status --json` when a
 * CLI exists (PATH, or the Mac app's bundle), else an interface holding an
 * address in Tailscale's 100.64.0.0/10 range. Never an install, never a
 * login — those are the user's, in Tailscale's own UI.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';

export interface Tailnet {
  /** The IPv4 address on the tailnet, e.g. `100.94.221.98`. */
  ip: string;
  /** MagicDNS name without the trailing dot, e.g. `laptop.tail1234.ts.net`. */
  dnsName?: string;
  /**
   * An HTTPS port `tailscale serve` maps onto Foreman's own port, when one
   * is configured. Tailscale terminates TLS with a certificate for the node
   * name; Foreman never holds a key. Links prefer this origin when present.
   */
  httpsPort?: number;
  /** HTTPS ports `serve` already uses for something else — so a hint can pick a free one. */
  httpsInUse?: number[];
}

/** True for addresses in 100.64.0.0/10, the CGNAT range Tailscale hands out. */
export function isTailscaleIp(ip: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** The parts of `tailscale status --json` Foreman reads; null when not running or unusable. */
export function parseTailscaleStatus(json: unknown): Tailnet | null {
  const d = json as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } } | null;
  if (!d || d.BackendState !== 'Running') return null;
  const ip = (d.Self?.TailscaleIPs ?? []).find(isTailscaleIp);
  if (!ip) return null;
  const dns = (d.Self?.DNSName ?? '').replace(/\.$/, '');
  return { ip, ...(dns ? { dnsName: dns } : {}) };
}

/** An interface carrying a tailnet address, when the CLI is not around to ask. */
export function tailnetFromInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): Tailnet | null {
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && isTailscaleIp(i.address)) return { ip: i.address };
    }
  }
  return null;
}

/**
 * The parts of `tailscale serve status --json` Foreman reads: which HTTPS
 * port, if any, proxies "/" to this port on loopback. `--bg` config only;
 * a foreground `serve` is the same on the wire and shows up the same way.
 */
export function parseServeStatus(json: unknown, port: number): { httpsPort?: number; httpsInUse: number[] } {
  const d = json as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null;
  const inUse: number[] = [];
  let httpsPort: number | undefined;
  for (const [hostPort, site] of Object.entries(d?.Web ?? {})) {
    const p = Number(hostPort.split(':').pop());
    if (!Number.isFinite(p)) continue;
    inUse.push(p);
    const proxy = site.Handlers?.['/']?.Proxy ?? '';
    const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/.exec(proxy);
    if (m && Number(m[1]) === port && httpsPort === undefined) httpsPort = p;
  }
  return { httpsPort, httpsInUse: inUse };
}

/** The one command that gives Foreman a certificate: 443 when free, else the next conventional port. */
export function serveHint(port: number, inUse: number[] = []): string {
  const https = [443, 8443, 10000].find((p) => !inUse.includes(p)) ?? 8443;
  return `tailscale serve --bg${https === 443 ? '' : ` --https=${https}`} ${port}`;
}

const CLI_CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
];

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * The tailnet this machine is on, or null. Read-only; a few seconds at most.
 * With a port, also asks whether `tailscale serve` fronts it with HTTPS.
 */
export async function detectTailscale(port?: number): Promise<Tailnet | null> {
  for (const cmd of CLI_CANDIDATES) {
    const out = await run(cmd, ['status', '--json'], 3_000);
    if (!out) continue;
    let t: Tailnet | null = null;
    try { t = parseTailscaleStatus(JSON.parse(out)); } catch { /* not JSON — try the next */ }
    if (!t) continue;
    if (port && t.dnsName) {
      const serve = await run(cmd, ['serve', 'status', '--json'], 3_000);
      if (serve) {
        try {
          const { httpsPort, httpsInUse } = parseServeStatus(JSON.parse(serve), port);
          t = { ...t, ...(httpsPort ? { httpsPort } : {}), httpsInUse };
        } catch { /* no serve config, or an older CLI */ }
      }
    }
    return t;
  }
  return tailnetFromInterfaces();
}

/**
 * Where the tailnet reaches Foreman: `https://laptop.tail1234.ts.net` when
 * `tailscale serve` fronts it (the port only when it is not 443), else
 * `http://name:port`, else the address.
 */
export function tailnetUrl(t: Tailnet, port: number): string {
  if (t.httpsPort && t.dnsName) return `https://${t.dnsName}${t.httpsPort === 443 ? '' : `:${t.httpsPort}`}`;
  return `http://${t.dnsName ?? t.ip}:${port}`;
}
