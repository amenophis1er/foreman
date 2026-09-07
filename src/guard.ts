/**
 * Who is allowed to talk to Foreman, and from where.
 *
 * Foreman has no login: it trusts the network it listens on (loopback, and
 * the tailnet when there is one). That trust is only worth anything if a
 * request really comes from there, and two ordinary browser behaviours break
 * it without any network access at all:
 *
 *  - DNS rebinding. A page on `evil.example` can point its own name at
 *    127.0.0.1 and then fetch `http://evil.example:4177/runs` — same-origin
 *    as far as the browser is concerned, so no CORS preflight, and the
 *    response goes back to the attacker. The packets do arrive on loopback;
 *    what gives it away is the Host header, which still says
 *    `evil.example:4177`. Refusing every Host that is not a name Foreman
 *    actually answers to closes it — hence 421 Misdirected Request.
 *
 *  - Cross-site writes. Any page the operator happens to visit can POST a
 *    form or `fetch(..., {mode:'no-cors'})` at `http://localhost:4177/mkdir`.
 *    The browser labels those: an `Origin` header on the request, or
 *    `Sec-Fetch-Site: cross-site`. Unsafe methods are refused unless that
 *    label says the request came from Foreman's own page.
 *
 * Non-browser callers — curl, `src/cli.ts`, the Telegram code paths, the
 * tests — send neither header, and are left alone. This is a guard against
 * the browser, not an authentication scheme; it does not pretend to keep out
 * anyone who can already open a socket to the port.
 */
import type http from 'node:http';
import path from 'node:path';
import { underAnyRoot } from './policy.js';

/** What a Host header may say, given the port and the tailnet. */
interface GuardOpts {
  port: number;
  tailnet: { ip: string; dnsName?: string } | null;
  /** `FOREMAN_BIND=all`: the operator opened it wide on purpose, so any Host is theirs. */
  bindAll?: boolean;
}

export type GuardVerdict = { ok: true } | { ok: false; status: 421 | 403; error: string };

/** Methods that cannot change anything, so a cross-site one is harmless. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The `host:port` strings Foreman answers to. The MagicDNS name is kept
 * separately because `tailscale serve` may front it on 443 (or any other
 * HTTPS port), so its port is whatever the proxy chose and cannot be checked.
 */
function expectedHosts(opts: GuardOpts): { exact: Set<string>; anyPort: Set<string> } {
  const exact = new Set([
    `localhost:${opts.port}`,
    `127.0.0.1:${opts.port}`,
    `[::1]:${opts.port}`,
  ]);
  if (opts.tailnet?.ip) exact.add(`${opts.tailnet.ip}:${opts.port}`);
  const anyPort = new Set<string>();
  if (opts.tailnet?.dnsName) anyPort.add(opts.tailnet.dnsName.toLowerCase());
  return { exact, anyPort };
}

/** `laptop.ts.net:8443` → `laptop.ts.net`; `[::1]:4177` → `[::1]`. */
function hostOnly(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  const i = hostHeader.lastIndexOf(':');
  return i > 0 ? hostHeader.slice(0, i) : hostHeader;
}

function hostRecognised(host: string, opts: GuardOpts): boolean {
  const h = host.toLowerCase();
  const { exact, anyPort } = expectedHosts(opts);
  return exact.has(h) || anyPort.has(hostOnly(h));
}

/**
 * Is this request one Foreman should answer? Host first (rebinding), then —
 * for anything that can change state — the browser's own account of where the
 * request came from.
 */
export function requestAllowed(
  req: { method?: string; headers: http.IncomingHttpHeaders },
  opts: GuardOpts,
): GuardVerdict {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  if (!opts.bindAll) {
    if (!host || !hostRecognised(host, opts)) return { ok: false, status: 421, error: 'unrecognised Host' };
  } else if (!host) {
    return { ok: false, status: 421, error: 'unrecognised Host' };
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (origin) {
    return originAllowed(origin, host, opts)
      ? { ok: true }
      : { ok: false, status: 403, error: 'cross-site request refused' };
  }
  // No Origin: either a non-browser caller (curl, the CLI, the tests), or a
  // browser that told us where it came from the other way. `same-origin` and
  // `none` (typed in the address bar) are ours; `cross-site` and `same-site`
  // are not.
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none') return { ok: true };
  return { ok: false, status: 403, error: 'cross-site request refused' };
}

/** An Origin is ours when it is http/https at a host we answer to. */
function originAllowed(origin: string, host: string, opts: GuardOpts): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // With bindAll there is no list to check against, so the standard
  // same-origin rule is the honest one: the Origin must be the Host.
  if (opts.bindAll) {
    const authority = u.host.toLowerCase();
    return authority === host.toLowerCase();
  }
  return hostRecognised(u.host.toLowerCase(), opts);
}

/**
 * May Foreman look at (or write into) `target`? True when it resolves to one
 * of `roots` or somewhere beneath one. `path.resolve` collapses `..` first,
 * so `~/Projects/../../etc` is judged as `/etc` and refused; containment
 * itself is `underAnyRoot`, which is already the rule the permission cards use.
 */
export function pathPermitted(target: string, roots: Iterable<string>): boolean {
  return underAnyRoot(path.resolve(target), roots);
}
