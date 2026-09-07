/**
 * Startup preflight — turns the ways a fresh install can be wrong into one
 * readable screen instead of a stack trace (or, worse, silence).
 *
 * On credentials: Foreman runs on EITHER a Claude subscription OR an API key —
 * both are supported, and both report real per-run cost, so budgets bind either
 * way. What matters is that you know which one is active, because it determines
 * who pays. The check reports the active mode and only blocks when there is no
 * credential at all. Set FOREMAN_AUTH_MODE=api-key|subscription to assert the
 * one you intend; startup then fails on a mismatch rather than quietly billing
 * the other. Which provider a given project actually bills is a separate axis
 * — see provider.ts.
 */
import net from 'node:net';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { defaultInstance, describeInstance, effectiveConfigDir } from './instance.js';
import { discoverOllama, ollamaHost } from './ollama.js';
import { serveHint, tailnetUrl, type Tailnet } from './tailscale.js';
import { codexHome, codexModels, readCodexAuth } from './codex.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type CheckStatus = 'ok' | 'warn' | 'error';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Shown beneath a warn/error as the thing to actually do. */
  fix?: string;
}

/**
 * Every place Claude Code may hold a subscription credential. Both are checked:
 * CLAUDE_CONFIG_DIR relocates the file but not the macOS Keychain item, so a
 * machine can easily have one and not the other.
 */
function claudeCredentialsPaths(): string[] {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(
    (d): d is string => Boolean(d),
  );
  return [...new Set(dirs)].map((d) => path.join(d, '.credentials.json'));
}

/** Presence only — never reads the secret. macOS stores Claude Code auth here. */
function keychainHasCredentials(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials'], (err) =>
      resolve(!err),
    );
  });
}

/** Does this specific config dir hold a stored Claude Code login? */
export async function dirHasCredentials(configDir: string): Promise<boolean> {
  return exists(path.join(configDir, '.credentials.json'));
}

/** Machine-wide Keychain login (macOS). Not tied to any one config dir. */
export const hasKeychainCredentials = keychainHasCredentials;

/** Who a config dir is signed in as. Reads only non-secret identity fields. */
export interface AccountInfo { email?: string; org?: string }

export async function readAccount(configDir: string): Promise<AccountInfo> {
  try {
    const raw = await readFile(path.join(configDir, '.claude.json'), 'utf8');
    const acct = (JSON.parse(raw) as { oauthAccount?: Record<string, string> }).oauthAccount;
    if (!acct) return {};
    return { email: acct.emailAddress, org: acct.organizationName };
  } catch {
    return {};
  }
}

async function exists(p: string): Promise<boolean> {
  return access(p, constants.F_OK).then(() => true, () => false);
}

export type AuthMode = 'api-key' | 'subscription' | 'cloud' | 'none';

/** Which credential the SDK will actually pick up, and where it came from. */
export async function detectAuth(): Promise<{ mode: AuthMode; source: string; account?: AccountInfo }> {
  if (process.env.ANTHROPIC_API_KEY) return { mode: 'api-key', source: 'ANTHROPIC_API_KEY' };
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { mode: 'api-key', source: 'ANTHROPIC_AUTH_TOKEN' };
  if (process.env.CLAUDE_CODE_USE_BEDROCK) return { mode: 'cloud', source: 'Bedrock' };
  if (process.env.CLAUDE_CODE_USE_VERTEX) return { mode: 'cloud', source: 'Vertex' };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { mode: 'subscription', source: 'CLAUDE_CODE_OAUTH_TOKEN' };
  }

  // The dir the AGENT will use — CLAUDE_CODE_CONFIG_DIR inherited from the
  // launching shell counts. Reporting any other dir would name an account that
  // is not the one being billed.
  const dir = effectiveConfigDir({});
  const account = await readAccount(dir);
  const stored = (await exists(path.join(dir, '.credentials.json'))) || (await keychainHasCredentials());
  if (stored || account.email) return { mode: 'subscription', source: dir, account };

  return { mode: 'none', source: '' };
}

const MODE_LABEL: Record<AuthMode, string> = {
  'api-key': 'API key',
  subscription: 'Claude subscription',
  cloud: 'cloud provider',
  none: 'none',
};

async function checkAuth(): Promise<Check> {
  const name = 'Credentials';
  const { mode, source, account } = await detectAuth();

  if (mode === 'none') {
    return {
      name,
      status: 'error',
      detail: 'none found — no missions can run',
      fix: 'Log in with Claude Code, or: export ANTHROPIC_API_KEY=sk-ant-...',
    };
  }

  const expected = process.env.FOREMAN_AUTH_MODE;
  if (expected && expected !== mode) {
    return {
      name,
      status: 'error',
      detail: `expected ${expected}, but ${MODE_LABEL[mode]} is active (${source})`,
      fix:
        expected === 'api-key'
          ? 'export ANTHROPIC_API_KEY=sk-ant-...   (an unset key silently falls back to your Claude Code login)'
          : 'unset ANTHROPIC_API_KEY to use the subscription, or drop FOREMAN_AUTH_MODE',
    };
  }

  const who = account?.email ? `${account.email}${account.org ? ` · ${account.org}` : ''}` : source;
  return { name, status: 'ok', detail: `${MODE_LABEL[mode]} — ${who}` };
}

function checkInstance(): Check {
  return { name: 'Claude Code', status: 'ok', detail: describeInstance(defaultInstance()) };
}

/**
 * A local Ollama, if one is running.
 *
 * Absent is the common case and not a problem, so this reports nothing at all
 * rather than a reassuring "not found" — the preflight screen exists to show
 * what would stop a mission, and an unused capability is not that. When one IS
 * running it is worth a line, because it means models are available with no
 * configuration and the operator should know they are on offer.
 */
async function checkOllama(): Promise<Check | null> {
  const models = await discoverOllama(1200);
  if (!models) return null;
  const local = models.filter((m) => !m.remote).length;
  const cloud = models.length - local;
  const parts = [
    local ? `${local} local` : null,
    cloud ? `${cloud} cloud` : null,
  ].filter(Boolean).join(' · ');
  return {
    name: 'Ollama',
    status: models.length ? 'ok' : 'warn',
    detail: models.length ? `${ollamaHost()} — ${parts}` : `${ollamaHost()} — running, no models pulled`,
    fix: models.length ? undefined : 'ollama pull <model>, or use a :cloud model',
  };
}

/**
 * A Codex install, if there is one.
 *
 * Silent when Codex is not installed, for the same reason as Ollama. But an
 * install with no login IS worth a warning rather than silence: the operator
 * put Codex there on purpose, so a project pinned to it will fail, and the fix
 * is one command.
 */
async function checkCodex(): Promise<Check | null> {
  const home = codexHome();
  const auth = await readCodexAuth(home).catch(() => null);
  const installed = await exists(path.join(home, 'auth.json'))
    || await exists(path.join(home, 'config.toml'));
  if (!installed) return null;

  if (!auth) {
    return {
      name: 'Codex',
      status: 'warn',
      detail: `${home} — installed, not signed in`,
      fix: 'codex login   (Foreman reads that login; it never mints its own token)',
    };
  }
  const models = await codexModels(home);
  const how = auth.OPENAI_API_KEY ? 'API key' : 'ChatGPT subscription';
  return {
    name: 'Codex',
    status: 'ok',
    detail: `${home} — ${how}${models.length ? ` · ${models.length} models` : ''}`,
  };
}

async function checkPort(port: number, envVar: 'PORT' | 'FOREMAN_SERVICES_PORT' = 'PORT'): Promise<Check> {
  const name = `Port ${port}`;
  const inUse = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });

  return inUse
    ? {
        name,
        status: 'error',
        detail: 'already in use',
        fix: `Another Foreman may be running. Stop it, or: ${envVar}=${port + 1} npm start`,
      }
    : { name, status: 'ok', detail: 'free' };
}

async function checkHome(root: string): Promise<Check> {
  const name = 'Data directory';
  try {
    await mkdir(root, { recursive: true });
    await access(root, constants.W_OK);
    return { name, status: 'ok', detail: root };
  } catch (err) {
    return {
      name,
      status: 'error',
      detail: `${root} is not writable (${String(err)})`,
      fix: 'Fix permissions, or point elsewhere: FOREMAN_HOME=/path/to/dir npm start',
    };
  }
}

/**
 * The browser missions get when "browser" is on. The Playwright MCP defaults
 * to the `chrome` channel — the Google Chrome already on the machine — which
 * is why a fresh install needs no browser download. `FOREMAN_BROWSER` picks
 * another channel or Playwright's own Chromium (installed with
 * `npx playwright install chromium`).
 */
async function checkBrowser(): Promise<Check> {
  const name = 'Browser';
  const want = (process.env.FOREMAN_BROWSER || 'chrome').toLowerCase();
  const candidates: Record<string, string[]> = {
    chrome: process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
      : process.platform === 'win32'
        ? [
            path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    msedge: process.platform === 'darwin' ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : process.platform === 'win32' ? [path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    firefox: process.platform === 'darwin' ? ['/Applications/Firefox.app/Contents/MacOS/firefox'] : ['/usr/bin/firefox'],
  };
  let found: string | null = null;
  if (want === 'chromium') {
    // Playwright's own build, wherever the MCP's playwright-core says it lives.
    try {
      const req = createRequire(fileURLToPath(new URL('../node_modules/@playwright/mcp/cli.js', import.meta.url)));
      const { chromium } = req('playwright-core') as { chromium: { executablePath(): string } };
      const p = chromium.executablePath();
      if (await exists(p)) found = p;
    } catch { /* no playwright-core to ask */ }
    return found
      ? { name, status: 'ok', detail: `Playwright Chromium — ${found}` }
      : { name, status: 'warn', detail: 'FOREMAN_BROWSER=chromium but Playwright Chromium is not installed; browser missions will fail', fix: 'npx playwright install chromium' };
  }
  for (const p of candidates[want] ?? []) if (await exists(p)) { found = p; break; }
  return found
    ? { name, status: 'ok', detail: `${want === 'chrome' ? 'Google Chrome' : want} — ${found}` }
    : { name, status: 'warn', detail: `no ${want === 'chrome' ? 'Google Chrome' : want} found; missions with browser on will fail`, fix: 'Install Google Chrome, or: npx playwright install chromium && FOREMAN_BROWSER=chromium foreman' };
}

/** Where the phone can reach this. Says so plainly either way — the answer decides which links work. */
function checkTailnet(t: Tailnet | null, port: number): Check {
  return t
    ? (t.httpsPort
        ? { name: 'Tailscale', status: 'ok', detail: `${tailnetUrl(t, port)} — HTTPS via tailscale serve; phone links use it` }
        : { name: 'Tailscale', status: 'ok', detail: `${tailnetUrl(t, port)} — listening there too; phone links use it. For HTTPS: ${serveHint(port, t.httpsInUse)}` })
    : { name: 'Tailscale', status: 'ok', detail: 'not running — localhost only; phone links need a public URL in Settings → Notifications' };
}

async function checkUi(distDir: string): Promise<Check> {
  const name = 'Dashboard';
  return (await exists(path.join(distDir, 'index.html')))
    ? { name, status: 'ok', detail: 'built' }
    : {
        name,
        status: 'warn',
        detail: 'ui/dist not built — the API works, the dashboard does not',
        fix: 'npm run ui:build',
      };
}

/**
 * Runs every check. Pure: callers decide how to report and whether to exit.
 */
export async function preflight(opts: {
  port: number;
  /** The second listener, for the crew's exposed dev servers — see services.ts. */
  servicesPort: number;
  foremanHome: string;
  distDir: string;
  /** Detected by the server before preflight; null when not on a tailnet. */
  tailnet?: Tailnet | null;
}): Promise<Check[]> {
  const checks = await Promise.all([
    Promise.resolve(checkTailnet(opts.tailnet ?? null, opts.port)),
    checkAuth(),
    checkInstance(),
    checkOllama(),
    checkCodex(),
    checkPort(opts.port),
    checkPort(opts.servicesPort, 'FOREMAN_SERVICES_PORT'),
    checkBrowser(),
    checkHome(opts.foremanHome),
    checkUi(opts.distDir),
  ]);
  // A null is a check that had nothing worth saying — see checkOllama().
  return checks.filter((c): c is Check => c !== null);
}

const GLYPH: Record<CheckStatus, string> = { ok: '✓', warn: '!', error: '✗' };

/** Prints the checklist. Returns true when nothing blocks startup. */
export function reportPreflight(checks: Check[]): boolean {
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log('Foreman preflight');
  for (const c of checks) {
    console.log(`  ${GLYPH[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') console.log(`      ${c.fix}`);
  }

  const failed = checks.filter((c) => c.status === 'error');
  if (failed.length) {
    console.log(`\nNot starting — ${failed.length} blocking problem(s) above.`);
    return false;
  }
  console.log('');
  return true;
}
