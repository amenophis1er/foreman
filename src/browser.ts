/**
 * The browser missions get, and how one is installed when there is none.
 *
 * The crew's browser is Playwright's MCP in headless mode with its own
 * profile — never the person's Chrome. Which executable it drives used to be
 * a fixed channel: Chrome unless FOREMAN_BROWSER said otherwise. On a machine
 * with no Chrome that failed even after a director had downloaded Playwright's
 * own Chromium, because nothing looked for it. Now the choice is detected:
 * FOREMAN_BROWSER when set, else the machine's Chrome, else the Chromium
 * Playwright installs — and that last one can be installed from the setup
 * page, as the user, into Playwright's own cache, no root needed.
 */
import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** The Playwright MCP's entry point, shipped as Foreman's own dependency. */
export const PLAYWRIGHT_MCP_CLI = fileURLToPath(new URL('../node_modules/@playwright/mcp/cli.js', import.meta.url));

export type BrowserChannel = 'chrome' | 'msedge' | 'firefox' | 'chromium';

export interface BrowserFound {
  channel: BrowserChannel;
  path: string;
  /** What to call it in a sentence. */
  label: string;
}

const exists = (p: string) => access(p, constants.F_OK).then(() => true, () => false);

/** The playwright-core the MCP itself uses — the one whose Chromium build the MCP can drive. */
function playwrightCore(): { dir: string; chromiumPath: string | null } | null {
  try {
    const req = createRequire(PLAYWRIGHT_MCP_CLI);
    const dir = path.dirname(req.resolve('playwright-core/package.json'));
    let chromiumPath: string | null = null;
    try {
      chromiumPath = (req('playwright-core') as { chromium: { executablePath(): string } }).chromium.executablePath();
    } catch { /* no build registered */ }
    return { dir, chromiumPath };
  } catch {
    return null;
  }
}

function candidates(channel: Exclude<BrowserChannel, 'chromium'>): string[] {
  const mac = process.platform === 'darwin';
  const win = process.platform === 'win32';
  switch (channel) {
    case 'chrome':
      return mac
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
        : win
          ? [
              path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
              path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
              path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            ]
          : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
    case 'msedge':
      return mac ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : win ? [path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
        : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
    case 'firefox':
      return mac ? ['/Applications/Firefox.app/Contents/MacOS/firefox'] : ['/usr/bin/firefox'];
  }
}

const LABEL: Record<BrowserChannel, string> = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox', chromium: 'Playwright Chromium' };

async function find(channel: BrowserChannel): Promise<BrowserFound | null> {
  if (channel === 'chromium') {
    const p = playwrightCore()?.chromiumPath ?? null;
    return p && (await exists(p)) ? { channel, path: p, label: LABEL.chromium } : null;
  }
  for (const p of candidates(channel)) if (await exists(p)) return { channel, path: p, label: LABEL[channel] };
  return null;
}

/**
 * The browser missions will run on, or null when there is none. Honours
 * FOREMAN_BROWSER as a pin (an explicit choice is never silently replaced);
 * otherwise Chrome, then Playwright's Chromium, in that order — Chrome needs
 * no download and is what most machines have.
 */
export async function detectBrowser(): Promise<BrowserFound | null> {
  const pinned = (process.env.FOREMAN_BROWSER || '').toLowerCase() as BrowserChannel | '';
  if (pinned) return (['chrome', 'msedge', 'firefox', 'chromium'] as BrowserChannel[]).includes(pinned) ? find(pinned) : null;
  return (await find('chrome')) ?? (await find('chromium'));
}

/**
 * Can the executable actually start? On Linux a downloaded Chromium is a
 * file that exists and a browser that does not: the system libraries it links
 * against (glib, nss, …) are packages, and a slim machine lacks them. `--version`
 * exits at once either way and fails with the loader's own message when they
 * are missing. Only asked on Linux; elsewhere the download is the browser.
 */
export function browserStarts(executable: string): Promise<string | null> {
  if (process.platform !== 'linux') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: 8000 }, (err, _stdout, stderr) => {
      if (!err) return resolve(null);
      const text = String(stderr || err.message).trim().split('\n').pop() ?? '';
      const lib = /error while loading shared libraries: ([^:]+)/.exec(text)?.[1];
      resolve(lib ? `missing system library ${lib}` : text || 'it did not start');
    });
  });
}

/** The preflight row for the browser, from the same detection the crew gets. */
export async function browserCheck(): Promise<{ status: 'ok' | 'warn'; detail: string; fix?: string }> {
  const pinned = process.env.FOREMAN_BROWSER;
  const found = await detectBrowser();
  if (found) {
    const broken = await browserStarts(found.path);
    if (!broken) return { status: 'ok', detail: `${found.label} — ${found.path}` };
    return {
      status: 'warn',
      detail: `${found.label} is installed but cannot start: ${broken}`,
      // Root, once, and not something Foreman will do itself.
      fix: 'The libraries are system packages and need root once: sudo npx playwright install-deps chromium',
    };
  }
  return {
    status: 'warn',
    detail: pinned
      ? `FOREMAN_BROWSER=${pinned} but no such browser was found; missions with browser on will fail`
      : 'no Google Chrome or Playwright Chromium found; missions with browser on will fail',
    fix: pinned
      ? 'Install it, or unset FOREMAN_BROWSER to let Foreman pick'
      : 'Install Google Chrome, or install Playwright Chromium from the dashboard\'s setup page (or: npx playwright install chromium)',
  };
}

/**
 * Installs Playwright's Chromium with playwright-core's own CLI — the same
 * package the MCP loads, so the build it downloads is the one it can drive.
 * Runs as the user, into Playwright's cache under the home directory; no
 * root. Resolves to null on success or one sentence on failure. Progress
 * lines (download percentages) are passed on as they arrive.
 *
 * On Linux the download can succeed while the system libraries Chromium
 * needs are missing; those need root (`playwright install-deps`), which this
 * never asks for — the message says so when it looks that way.
 */
export function installChromium(onProgress?: (line: string) => void, timeoutMs = 10 * 60_000): Promise<string | null> {
  const core = playwrightCore();
  if (!core) return Promise.resolve('Playwright is not available in this install of Foreman.');
  const cli = path.join(core.dir, 'cli.js');
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      return done(`Could not start the installer: ${err instanceof Error ? err.message : String(err)}`);
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(`The download took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`); }, timeoutMs);
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      out += text;
      if (out.length > 64_000) out = out.slice(-32_000);
      for (const piece of text.split(/[\r\n]+/)) {
        const line = piece.trim();
        if (line) onProgress?.(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { clearTimeout(timer); done(`Could not run the installer: ${err.message}`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return done(null);
      const last = out.trim().split('\n').filter(Boolean).pop() ?? '';
      const hint = process.platform === 'linux' && /install-deps|missing dependencies|libnss|shared libraries/i.test(out)
        ? ' Chromium is downloaded but some system libraries are missing; they need root: sudo npx playwright install-deps chromium.'
        : '';
      done(`The installer exited with code ${code}${last ? `: ${last}` : ''}.${hint}`);
    });
  });
}
