#!/usr/bin/env node
/**
 * The `foreman` command.
 *
 * Everything resolves from this file's own location rather than the working
 * directory, so the server can be started from anywhere — which is the whole
 * point of having a bin. `src/` ships as TypeScript, so tsx is registered as a
 * loader here rather than requiring a build step before first run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const USAGE = `foreman ${pkg.version}

  foreman [start]     Start the server and serve the dashboard
  foreman --version   Print the version
  foreman --help      Show this message

Environment:
  PORT                        Listen port (default 4177)
  FOREMAN_HOME                State directory (default ~/.foreman)
  FOREMAN_CLAUDE_CONFIG_DIR   Claude Code install missions run under
  FOREMAN_CLAUDE_EXECUTABLE   Claude Code executable (default: bundled)
  FOREMAN_AUTH_MODE           Assert 'api-key' or 'subscription'; fail on mismatch
`;

const [command = 'start', ...rest] = process.argv.slice(2);

if (command === '--help' || command === '-h' || rest.includes('--help')) {
  process.stdout.write(USAGE);
} else if (command === '--version' || command === '-v') {
  process.stdout.write(`${pkg.version}\n`);
} else if (command === 'start') {
  register();
  await import(new URL('../src/server.ts', import.meta.url).href);
} else {
  process.stderr.write(`foreman: unknown command "${command}"\n\n${USAGE}`);
  process.exit(1);
}
