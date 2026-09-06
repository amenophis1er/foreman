#!/usr/bin/env node
// Builds the dashboard so the package ships with one:
//   npm publish        runs it via prepack (--force) — every tarball has ui/dist
//   npm run setup      in a checkout, after npm ci
// Not a `prepare`/`postinstall` hook on purpose: npm 11 warns about (and
// blocks) lifecycle scripts on global installs, and the tarball already has
// the build. Skips when nothing changed; `--force` always builds.
// Never fails an install that cannot build: the API still works without the
// dashboard, and the preflight says so on start.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.join(root, 'ui');
const dist = path.join(ui, 'dist', 'index.html');
const force = process.argv.includes('--force');
const quiet = process.env.FOREMAN_SKIP_UI_BUILD === '1';

if (quiet) process.exit(0);
if (!existsSync(path.join(ui, 'package.json'))) process.exit(0); // not shipped with sources — nothing to build

function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

const stale = force || !existsSync(dist) || newest(path.join(ui, 'src')) > statSync(dist).mtimeMs
  || statSync(path.join(ui, 'package.json')).mtimeMs > statSync(dist).mtimeMs;
if (!stale) process.exit(0);

try {
  if (!existsSync(path.join(ui, 'node_modules'))) {
    console.log('foreman: installing dashboard dependencies…');
    execSync('npm ci --no-audit --no-fund', { cwd: ui, stdio: 'inherit' });
  }
  console.log('foreman: building the dashboard…');
  execSync('npm run build', { cwd: ui, stdio: 'inherit' });
} catch (err) {
  if (force) { console.error('foreman: dashboard build failed — refusing to pack without it'); process.exit(1); }
  console.warn(`foreman: dashboard build skipped (${err.message.split('\n')[0]}). The API works; the dashboard will not until \`npm run ui:build\`.`);
}
