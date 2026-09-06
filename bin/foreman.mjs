#!/usr/bin/env node
/**
 * The `foreman` command.
 *
 * Everything resolves from this file's own location rather than the working
 * directory, so the server can be started from anywhere — which is the whole
 * point of having a bin. `src/` ships as TypeScript, so tsx is registered as a
 * loader here rather than requiring a build step before first run.
 *
 *   npx @amenophis1er/foreman          start, right now, from nothing
 *   npm i -g @amenophis1er/foreman     then `foreman` from any shell
 */
import { readFileSync } from 'node:fs';
import { register } from 'tsx/esm/api';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const USAGE = `foreman ${pkg.version}

  foreman                    Start in this terminal (same as "start"); Ctrl+C stops it
  foreman up                 Start in the background; logs to ~/.foreman/logs/server.log
  foreman down               Stop a background server started with "up"
  foreman status             Is a server up? Which port, which pid?
  foreman doctor             Check credentials, providers, browser, port, Tailscale — and exit
  foreman open               Open the dashboard in your browser
  foreman service install    Keep Foreman running: start at login, restart if it dies
  foreman service uninstall  Remove that
  foreman service status     Is the service registered and running?
  foreman service logs       Tail the service's log
  foreman --version | --help

Environment:
  PORT                        Listen port (default 4177)
  FOREMAN_HOME                State directory (default ~/.foreman)
  FOREMAN_BIND                auto (loopback + Tailscale, default) | local | all
  FOREMAN_BROWSER             Browser for missions: chrome (default), chromium, msedge, firefox
  FOREMAN_CLAUDE_CONFIG_DIR   Claude Code install missions run under
  FOREMAN_CLAUDE_EXECUTABLE   Claude Code executable (default: bundled)
  FOREMAN_AUTH_MODE           Assert 'api-key' or 'subscription'; fail on mismatch
`;

const [command = 'start', ...rest] = process.argv.slice(2);

if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(USAGE);
} else if (command === '--version' || command === '-v' || command === 'version') {
  process.stdout.write(`${pkg.version}\n`);
} else if (command === 'start') {
  register();
  await import(new URL('../src/server.ts', import.meta.url).href);
} else if (['doctor', 'open', 'service', 'up', 'down', 'status'].includes(command)) {
  register();
  const { runCli } = await import(new URL('../src/cli.ts', import.meta.url).href);
  process.exitCode = await runCli(command, rest, { version: pkg.version, bin: new URL(import.meta.url) });
} else {
  process.stderr.write(`foreman: unknown command "${command}"\n\n${USAGE}`);
  process.exit(1);
}
