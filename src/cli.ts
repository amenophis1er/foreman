/**
 * The subcommands behind `foreman` that are not "start the server".
 *
 *  doctor   The preflight, and nothing else: what this machine can run, what
 *           is missing, how to fix it. Exit 0 when nothing blocks.
 *  open     The dashboard, in the default browser.
 *  up/down  A background server without registering anything: a detached
 *           child, a pid file and a log under ~/.foreman. For "just run it";
 *           `service install` is for "always run it".
 *  service  Keep Foreman up without a terminal: a launchd agent on macOS, a
 *           systemd user unit on Linux. Start at login, restart on crash,
 *           log to ~/.foreman/logs. Foreman on the move needs the server to
 *           be up when the laptop lid is closed; this is that.
 */
import { execFile, spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight, reportPreflight } from './preflight.js';
import { detectTailscale } from './tailscale.js';
import { PACKAGE, checkForUpdate, currentVersion } from './update.js';

const PORT = Number(process.env.PORT ?? 4177);
const HOME_DIR = process.env.FOREMAN_HOME || path.join(os.homedir(), '.foreman');
const LABEL = 'dev.foreman.server';
const PID_FILE = path.join(HOME_DIR, 'foreman.pid');
const LOG_FILE = path.join(HOME_DIR, 'logs', 'server.log');

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000 }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0;
      resolve({ code, out: String(out), err: String(err) });
    });
  });
}

/** The PATH a login agent gets is thin; node's own dir and the usual prefixes are added so `claude`, `tailscale`, `ollama` resolve. */
export function servicePath(execPath: string, current = process.env.PATH ?? ''): string {
  const parts = [path.dirname(execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...current.split(':')];
  return [...new Set(parts.filter(Boolean))].join(':');
}

/** The launchd property list for the agent. Pure, so it can be read in a test and by a human. */
export function launchdPlist(opts: { label: string; node: string; bin: string; home: string; logDir: string; env: Record<string, string> }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const envXml = Object.entries(opts.env).map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(opts.node)}</string>
    <string>${esc(opts.bin)}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(opts.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(path.join(opts.logDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(opts.logDir, 'server.log'))}</string>
</dict>
</plist>
`;
}

/** The systemd user unit. Same shape as the plist: start at login, restart on failure, one log. */
export function systemdUnit(opts: { node: string; bin: string; home: string; env: Record<string, string> }): string {
  const envLines = Object.entries(opts.env).map(([k, v]) => `Environment=${k}=${v.replace(/"/g, '\\"')}`).join('\n');
  return `[Unit]
Description=Foreman — autonomous mission runner
After=network-online.target

[Service]
ExecStart=${opts.node} ${opts.bin} start
WorkingDirectory=${opts.home}
Restart=always
RestartSec=5
${envLines}

[Install]
WantedBy=default.target
`;
}

function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: servicePath(process.execPath), HOME: os.homedir(), FOREMAN_HOME: HOME_DIR, PORT: String(PORT) };
  for (const k of ['FOREMAN_BIND', 'FOREMAN_BROWSER', 'FOREMAN_CLAUDE_CONFIG_DIR', 'FOREMAN_CLAUDE_EXECUTABLE', 'FOREMAN_AUTH_MODE', 'CLAUDE_CONFIG_DIR']) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

async function serviceInstall(bin: string): Promise<number> {
  const logDir = path.join(HOME_DIR, 'logs');
  await mkdir(logDir, { recursive: true });
  // A background server started with `foreman up` would keep the port and
  // make the new service crash-loop against it; hand over first.
  const pid = await readPid();
  if (pid && alive(pid)) { console.log('Stopping the background server so the service can take the port…'); await down(); }
  else if (await listening(PORT)) {
    console.error(`Something else answers on :${PORT} (a terminal session?). Stop it first, or the service will keep failing to bind.`);
    return 1;
  }
  const env = serviceEnv();
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const file = path.join(dir, `${LABEL}.plist`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, launchdPlist({ label: LABEL, node: process.execPath, bin, home: HOME_DIR, logDir, env }));
    await chmod(file, 0o644);
    const uid = String(os.userInfo().uid);
    await sh('launchctl', ['bootout', `gui/${uid}/${LABEL}`]); // replace a previous registration quietly
    const r = await sh('launchctl', ['bootstrap', `gui/${uid}`, file]);
    if (r.code !== 0) { console.error(`launchctl bootstrap failed: ${r.err.trim() || r.out.trim()}`); return 1; }
    console.log(`Installed ${file}\nForeman starts at login and restarts if it dies. Logs: ${path.join(logDir, 'server.log')}\nDashboard: http://localhost:${PORT}`);
    return 0;
  }
  if (process.platform === 'linux') {
    // A container, a minimal server, WSL without systemd: no user manager to
    // talk to. Say that, and point at the way that still works.
    const probe = await sh('systemctl', ['--user', 'is-system-running']);
    const noManager = probe.code !== 0 && !/degraded|running|starting/.test(probe.out);
    if (noManager) {
      console.error('No systemd user session here (a container, or WSL without systemd). Use `foreman up`, or run `foreman` under your own supervisor.');
      return 2;
    }
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const file = path.join(dir, 'foreman.service');
    await mkdir(dir, { recursive: true });
    await writeFile(file, systemdUnit({ node: process.execPath, bin, home: HOME_DIR, env }));
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'foreman']]) {
      const r = await sh('systemctl', args);
      if (r.code !== 0) { console.error(`systemctl ${args.join(' ')} failed: ${(r.err.trim() || r.out.trim()) || 'no output — is a systemd user session running?'}`); return 1; }
    }
    console.log(`Installed ${file}\nForeman starts at login and restarts if it dies. Logs: journalctl --user -u foreman -f\nTip: \`loginctl enable-linger $USER\` keeps it up when you are logged out.\nDashboard: http://localhost:${PORT}`);
    return 0;
  }
  console.error(`No service integration for ${process.platform} yet. \`foreman up\` runs it in the background; on Windows, Task Scheduler or WSL2 with systemd keeps it up.`);
  return 2;
}

async function serviceUninstall(): Promise<number> {
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    await sh('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`]);
    await rm(file, { force: true });
    console.log('Removed. Foreman no longer starts at login.');
    return 0;
  }
  if (process.platform === 'linux') {
    await sh('systemctl', ['--user', 'disable', '--now', 'foreman']);
    await rm(path.join(os.homedir(), '.config', 'systemd', 'user', 'foreman.service'), { force: true });
    await sh('systemctl', ['--user', 'daemon-reload']);
    console.log('Removed. Foreman no longer starts at login.');
    return 0;
  }
  return 2;
}

/** Is the service registered, and is it running? Null pid when registered but idle. */
async function serviceState(): Promise<{ installed: boolean; running: boolean; pid?: number }> {
  if (process.platform === 'darwin') {
    // Installed means the plist is on disk; a stopped service (booted out
    // by `service stop`) is still installed, and `service start` brings it
    // back. launchctl only knows about loaded jobs, so it answers "running".
    const installed = await access(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)).then(() => true, () => false);
    const r = await sh('launchctl', ['print', `gui/${os.userInfo().uid}/${LABEL}`]);
    if (r.code !== 0) return { installed, running: false };
    const pid = Number(/pid = (\d+)/.exec(r.out)?.[1]);
    return { installed: true, running: Number.isFinite(pid) && pid > 0, ...(pid ? { pid } : {}) };
  }
  if (process.platform === 'linux') {
    const enabled = await sh('systemctl', ['--user', 'is-enabled', 'foreman']);
    const active = await sh('systemctl', ['--user', 'is-active', 'foreman']);
    return { installed: enabled.out.trim() === 'enabled' || active.out.trim() === 'active', running: active.out.trim() === 'active' };
  }
  return { installed: false, running: false };
}

/** Stop the service without removing it; `service start` brings it back. */
async function serviceStop(): Promise<number> {
  const st = await serviceState();
  if (!st.installed) { console.log('The service is not installed.'); return 1; }
  if (process.platform === 'darwin') {
    // bootout unloads the job until the next login or `service start`; a plain
    // kill would be undone by KeepAlive within seconds.
    const r = await sh('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`]);
    if (r.code !== 0 && st.running) { console.error(`launchctl bootout failed: ${r.err.trim() || r.out.trim()}`); return 1; }
  } else if (process.platform === 'linux') {
    const r = await sh('systemctl', ['--user', 'stop', 'foreman']);
    if (r.code !== 0) { console.error(`systemctl stop failed: ${r.err.trim() || r.out.trim()}`); return 1; }
  }
  console.log('Service stopped. `foreman service start` starts it again; it also comes back at next login.');
  return 0;
}

async function serviceStart(): Promise<number> {
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const r = await sh('launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, file]);
    if (r.code !== 0 && !/already/i.test(r.err)) { console.error(`launchctl bootstrap failed: ${r.err.trim() || r.out.trim() || 'is the service installed?'}`); return 1; }
  } else if (process.platform === 'linux') {
    const r = await sh('systemctl', ['--user', 'start', 'foreman']);
    if (r.code !== 0) { console.error(`systemctl start failed: ${r.err.trim() || r.out.trim()}`); return 1; }
  } else { return 2; }
  for (let i = 0; i < 40; i++) { if (await listening(PORT)) break; await new Promise((r) => setTimeout(r, 250)); }
  console.log((await listening(PORT)) ? `Service started · http://localhost:${PORT}` : `Service started; not answering yet — see ${LOG_FILE}`);
  return 0;
}

async function serviceRestart(): Promise<number> {
  if (process.platform === 'darwin') {
    const r = await sh('launchctl', ['kickstart', '-k', `gui/${os.userInfo().uid}/${LABEL}`]);
    if (r.code !== 0) { console.error(`launchctl kickstart failed: ${r.err.trim() || r.out.trim() || 'is the service installed?'}`); return 1; }
  } else if (process.platform === 'linux') {
    const r = await sh('systemctl', ['--user', 'restart', 'foreman']);
    if (r.code !== 0) { console.error(`systemctl restart failed: ${r.err.trim() || r.out.trim()}`); return 1; }
  } else { return 2; }
  for (let i = 0; i < 40; i++) { if (await listening(PORT)) break; await new Promise((r) => setTimeout(r, 250)); }
  console.log((await listening(PORT)) ? `Service restarted · http://localhost:${PORT}` : `Service restarted; not answering yet — see ${LOG_FILE}`);
  return 0;
}

async function serviceStatus(): Promise<number> {
  if (process.platform === 'darwin') {
    const r = await sh('launchctl', ['print', `gui/${os.userInfo().uid}/${LABEL}`]);
    if (r.code !== 0) {
      const st = await serviceState();
      console.log(st.installed ? 'Installed · stopped — `foreman service start` starts it (it also comes back at next login).' : 'Not installed. `foreman service install` keeps Foreman running.');
      return 1;
    }
    const state = /state = (\w+)/.exec(r.out)?.[1] ?? 'unknown';
    const pid = /pid = (\d+)/.exec(r.out)?.[1];
    console.log(`Installed · ${state}${pid ? ` · pid ${pid}` : ''} · http://localhost:${PORT}`);
    return 0;
  }
  if (process.platform === 'linux') {
    const r = await sh('systemctl', ['--user', 'is-active', 'foreman']);
    console.log(r.out.trim() === 'active' ? `Installed · active · http://localhost:${PORT}` : `Installed? ${r.out.trim() || 'no'} — \`foreman service install\``);
    return r.out.trim() === 'active' ? 0 : 1;
  }
  return 2;
}

async function serviceLogs(): Promise<number> {
  if (process.platform === 'linux') {
    const child = spawn('journalctl', ['--user', '-u', 'foreman', '-f', '-n', '100'], { stdio: 'inherit' });
    return new Promise((r) => child.on('exit', (c) => r(c ?? 0)));
  }
  const file = path.join(HOME_DIR, 'logs', 'server.log');
  const child = spawn('tail', ['-n', '100', '-f', file], { stdio: 'inherit' });
  return new Promise((r) => child.on('exit', (c) => r(c ?? 0)));
}

/** One quiet line when a newer version exists; nothing when current or unknown. */
async function updateHint(): Promise<void> {
  const u = await checkForUpdate(currentVersion(), 2_000);
  if (u?.newer) console.log(`\nForeman ${u.latest} is available (you have ${u.current}) — \`foreman update\``);
}

/** Anything a restart would cut off: a run, an ask waiting, a planner mid-reply. */
async function liveWork(): Promise<string | null> {
  try {
    const d = await fetch(`http://127.0.0.1:${PORT}/projects`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()) as { projects: Array<{ id: string; name: string; activeRun?: unknown; needs?: unknown[] }> };
    const running = d.projects.filter((p) => p.activeRun).map((p) => p.name);
    const needs = d.projects.reduce((n, p) => n + (p.needs?.length ?? 0), 0);
    const thinking: string[] = [];
    for (const p of d.projects) {
      try {
        const c = await fetch(`http://127.0.0.1:${PORT}/chat?projectId=${encodeURIComponent(p.id)}`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()) as { thinking?: boolean };
        if (c.thinking) thinking.push(p.name);
      } catch { /* a project whose chat cannot be read is not live work */ }
    }
    if (!running.length && !needs && !thinking.length) return null;
    return [running.length ? `running: ${running.join(', ')}` : '', needs ? `${needs} ask(s) waiting` : '', thinking.length ? `planner replying: ${thinking.join(', ')}` : ''].filter(Boolean).join(' · ');
  } catch { return null; } // not up — nothing to cut off
}

/**
 * Update the installed package and restart Foreman the way it is running.
 * Refuses while anything would be cut off; --force overrides, eyes open.
 * Never automatic: this is the one place the code under a mission changes,
 * and it happens by a human's hand.
 */
async function update(bin: string, flags: string[]): Promise<number> {
  const u = await checkForUpdate(currentVersion(), 5_000);
  if (!u) { console.error('Could not reach the npm registry to check for a newer version.'); return 1; }
  if (!u.newer) { console.log(`Already on the latest version (${u.current}).`); return 0; }
  const busy = await liveWork();
  if (busy && !flags.includes('--force')) {
    console.error(`Not updating: ${busy}. An update restarts the server and would cut that off. Wait, or \`foreman update --force\`.`);
    return 2;
  }
  console.log(`Updating ${u.current} → ${u.latest}…`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const code = await new Promise<number>((r) => {
    const c = spawn(npm, ['install', '-g', `${PACKAGE}@${u.latest}`, '--no-audit', '--no-fund'], { stdio: 'inherit' });
    c.on('exit', (x) => r(x ?? 1)); c.on('error', () => r(1));
  });
  if (code !== 0) { console.error('npm install failed; nothing was restarted.'); return code; }
  // Restart by the means it is running, so the new code actually serves.
  const pid = await readPid();
  if (pid && alive(pid)) { console.log('Restarting the background server…'); const c = await down(); if (c !== 0) return c; return up(bin); }
  const svc = await serviceState();
  if (svc.running || svc.installed) { console.log('Restarting the service…'); return serviceRestart(); }
  if (await listening(PORT)) { console.log(`Installed ${u.latest}. The server on :${PORT} runs in a terminal — restart it there to pick it up.`); return 0; }
  console.log(`Installed ${u.latest}. Start it with \`foreman\`, \`foreman up\` or \`foreman service install\`.`);
  return 0;
}

async function doctor(): Promise<number> {
  const tailnet = await detectTailscale(PORT);
  const distDir = fileURLToPath(new URL('../ui/dist', import.meta.url));
  const checks = await preflight({ port: PORT, foremanHome: HOME_DIR, distDir, tailnet });
  // Port-in-use is an error for `start` and a fact for `doctor`: it usually means Foreman is already up.
  for (const c of checks) {
    if (c.name.startsWith('Port') && c.status === 'error') { c.status = 'warn'; c.detail = 'in use — Foreman is probably already running'; c.fix = `foreman open · or PORT=${PORT + 1} foreman`; }
  }
  const ok = reportPreflight(checks);
  await updateHint();
  return ok ? 0 : 1;
}

async function open(): Promise<number> {
  const url = `http://localhost:${PORT}`;
  // `start` is a cmd builtin, not a program; xdg-open covers the Linux desktops.
  const r = process.platform === 'win32'
    ? await sh('cmd', ['/c', 'start', '', url])
    : await sh(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  if (r.code !== 0) console.log(url);
  return 0;
}

async function listening(port: number): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${port}/projects`, { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
}

async function readPid(): Promise<number | null> {
  try { const n = Number((await readFile(PID_FILE, 'utf8')).trim()); return Number.isInteger(n) && n > 0 ? n : null; }
  catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function up(bin: string): Promise<number> {
  if (await listening(PORT)) { console.log(`Already up at http://localhost:${PORT}`); return 0; }
  // One owner per port. With the service installed, a second server started
  // here would hold the port and leave launchd/systemd retrying its own copy
  // every few seconds against the preflight's "already in use".
  const svc = await serviceState();
  if (svc.installed) {
    console.log('The service runs Foreman on this machine. Use `foreman service start` (or `restart`); `foreman service uninstall` if you would rather run it by hand.');
    return 1;
  }
  await mkdir(path.dirname(LOG_FILE), { recursive: true });
  const out = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [bin, 'start'], {
    detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, FOREMAN_HOME: HOME_DIR },
  });
  child.unref();
  await writeFile(PID_FILE, `${child.pid}\n`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await listening(PORT)) {
      console.log(`Foreman is up at http://localhost:${PORT} (pid ${child.pid}) · log: ${LOG_FILE} · stop with: foreman down`);
      return 0;
    }
    if (child.pid && !alive(child.pid)) break;
  }
  console.error(`Foreman did not come up. The preflight may have refused — see ${LOG_FILE}`);
  await rm(PID_FILE, { force: true });
  return 1;
}

async function down(): Promise<number> {
  const pid = await readPid();
  if (!pid || !alive(pid)) {
    await rm(PID_FILE, { force: true });
    if (await listening(PORT)) { console.log(`Something answers on :${PORT} but it was not started with \`foreman up\` (a terminal, or the service). Stop it there.`); return 1; }
    console.log('Not up.'); return 0;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  await rm(PID_FILE, { force: true });
  console.log('Stopped.');
  return 0;
}

async function status(): Promise<number> {
  const pid = await readPid();
  const isUp = await listening(PORT);
  if (isUp) {
    const svc = await serviceState();
    const how = pid && alive(pid) ? `background, pid ${pid}` : svc.running ? `the service${svc.pid ? `, pid ${svc.pid}` : ''}` : 'a terminal';
    console.log(`Up at http://localhost:${PORT} (${how})`);
    await updateHint();
    return 0;
  }
  if (pid) await rm(PID_FILE, { force: true });
  console.log(`Not up. \`foreman up\` starts it in the background, \`foreman\` in this terminal.`);
  return 1;
}

/**
 * Stop whatever is serving :PORT, by the means it was started with. A
 * background server (pid file) is signalled; a service is stopped through
 * its manager, since killing it would only make KeepAlive restart it; a
 * terminal session is yours to Ctrl+C, and it says so.
 */
async function stop(): Promise<number> {
  const pid = await readPid();
  if (pid && alive(pid)) return down();
  const svc = await serviceState();
  if (svc.running) return serviceStop();
  if (await listening(PORT)) {
    console.log(`Something answers on :${PORT} that neither \`foreman up\` nor the service started — a terminal session, most likely. Stop it there (Ctrl+C).`);
    return 1;
  }
  await rm(PID_FILE, { force: true });
  console.log('Not up.');
  return 0;
}

async function restart(bin: string): Promise<number> {
  const pid = await readPid();
  if (pid && alive(pid)) { const c = await down(); if (c !== 0) return c; return up(bin); }
  const svc = await serviceState();
  if (svc.running) return serviceRestart();
  if (await listening(PORT)) {
    console.log(`The server on :${PORT} was started in a terminal; restart it there. (\`foreman up\` and \`foreman service install\` are the restartable ways to run it.)`);
    return 1;
  }
  return up(bin);
}

async function logs(): Promise<number> {
  const svc = await serviceState();
  if (process.platform === 'linux' && svc.installed) return serviceLogs();
  const child = spawn('tail', ['-n', '100', '-f', LOG_FILE], { stdio: 'inherit' });
  return new Promise((r) => child.on('exit', (c) => r(c ?? 0)));
}

/**
 * Take Foreman off this machine, in the right order: the service, then a
 * background server, then — only with --purge, which destroys every run's
 * history — the data directory. The package itself is npm's to remove; the
 * last line says how, because a bin cannot uninstall the package it lives in.
 */
async function uninstall(flags: string[]): Promise<number> {
  const purge = flags.includes('--purge');
  const svc = await serviceState();
  if (svc.installed) await serviceUninstall();
  const pid = await readPid();
  if (pid && alive(pid)) await down();
  if (purge) {
    if (!flags.includes('--yes')) {
      console.error(`--purge deletes ${HOME_DIR}: every run, its transcripts and settings, the Telegram link. Add --yes to confirm.`);
      return 2;
    }
    await rm(HOME_DIR, { recursive: true, force: true });
    console.log(`Removed ${HOME_DIR}.`);
  } else {
    console.log(`Kept ${HOME_DIR} (runs, settings). \`foreman uninstall --purge --yes\` removes it too.`);
  }
  console.log('Now remove the package:\n  npm uninstall -g @amenophis1er/foreman');
  return 0;
}

export async function runCli(command: string, rest: string[], ctx: { version: string; bin: URL }): Promise<number> {
  const bin = fileURLToPath(ctx.bin);
  switch (command) {
    case 'up': return up(bin);
    case 'down': return down();
    case 'update': return update(bin, rest);
    case 'stop': return stop();
    case 'restart': return restart(bin);
    case 'logs': return logs();
    case 'uninstall': return uninstall(rest);
    case 'status': return status();
    case 'doctor': return doctor();
    case 'open': return open();
    case 'service': {
      const sub = rest[0];
      if (sub === 'install') return serviceInstall(bin);
      if (sub === 'uninstall') return serviceUninstall();
      if (sub === 'start') return serviceStart();
      if (sub === 'stop') return serviceStop();
      if (sub === 'restart') return serviceRestart();
      if (sub === 'status') return serviceStatus();
      if (sub === 'logs') return serviceLogs();
      console.error('foreman service <install|uninstall|start|stop|restart|status|logs>');
      return 1;
    }
    default: return 1;
  }
}

/** For a test: where the plist would go. */
export function plistPathFor(home = os.homedir()): string { return path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`); }
