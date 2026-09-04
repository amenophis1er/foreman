/**
 * Claude Code instance selection.
 *
 * A machine can host several Claude Code installs side by side: distinct
 * CLAUDE_CONFIG_DIRs (each with its own credentials, settings, and plugins) and
 * potentially distinct executables. Which one a mission runs under decides
 * whose subscription or key it bills and which settings it inherits, so it is a
 * per-mission fact worth recording, not an ambient property of the server.
 *
 * Resolution is project-over-server: a project may pin an instance, otherwise
 * the server default from the environment applies, otherwise the SDK inherits
 * this process's own environment (the previous behaviour).
 */
import os from 'node:os';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface ClaudeInstance {
  /** CLAUDE_CONFIG_DIR for the agent — selects credentials, settings, plugins. */
  configDir?: string;
  /** Claude Code executable; the SDK's bundled one is used when absent. */
  executable?: string;
  /** `own-login` makes the pinned config dir's stored login pay. See types.ts. */
  billing?: 'inherit' | 'own-login';
}

/** Credentials that outrank a stored login and so must be dropped for `own-login`. */
const INHERITED_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** Expands a leading `~` so config can be written the way people type it. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? expandHome(trimmed) : undefined;
}

/** Server-wide default, from the environment. */
export function defaultInstance(): ClaudeInstance {
  return {
    configDir: clean(process.env.FOREMAN_CLAUDE_CONFIG_DIR),
    executable: clean(process.env.FOREMAN_CLAUDE_EXECUTABLE),
  };
}

/**
 * Project override wins field by field, so a project can pin a config dir
 * while still inheriting the server's executable.
 */
export function resolveInstance(override?: ClaudeInstance): ClaudeInstance {
  const base = defaultInstance();
  return {
    configDir: clean(override?.configDir) ?? base.configDir,
    executable: clean(override?.executable) ?? base.executable,
    billing: override?.billing ?? 'inherit',
  };
}

/**
 * The `query()` options fragment for an instance.
 *
 * `env` replaces the child's environment rather than extending it, so
 * process.env is spread first — dropping it would strip PATH, HOME, and the
 * ANTHROPIC_* credentials along with it.
 */
export function instanceOptions(instance: ClaudeInstance): {
  env?: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
} {
  const options: ReturnType<typeof instanceOptions> = {};
  const ownLogin = instance.billing === 'own-login';

  if (instance.configDir || ownLogin) {
    const env: Record<string, string | undefined> = { ...process.env };
    if (instance.configDir) env.CLAUDE_CONFIG_DIR = instance.configDir;
    // Deleting is not enough on its own — `env` is spread from process.env, so
    // an inherited key would otherwise reach the child and outrank the login.
    if (ownLogin) for (const v of INHERITED_KEY_VARS) delete env[v];
    options.env = env;
  }
  if (instance.executable) options.pathToClaudeCodeExecutable = instance.executable;
  return options;
}

/**
 * One-line description for the preflight screen and run history.
 *
 * Resolves through effectiveConfigDir rather than assuming ~/.claude, because a
 * CLAUDE_CONFIG_DIR inherited from the launching shell silently selects a
 * different account — and printing the wrong directory here is worse than
 * printing nothing, since this line is what someone checks before spending.
 */
export function describeInstance(instance: ClaudeInstance): string {
  const dir = effectiveConfigDir(instance);
  const inherited = !instance.configDir ? ' (inherited)' : '';
  return [
    `${dir}${inherited}`,
    instance.executable ? path.basename(instance.executable) : 'bundled executable',
  ].join(' · ');
}

/** One Claude Code install offered in the project settings picker. */
export interface DiscoveredInstance {
  /** Absolute config dir (CLAUDE_CONFIG_DIR). */
  configDir: string;
  /** How it was found, for the muted hint in the picker. */
  origin: 'server default' | 'this process' | 'found on disk';
  /** Whether that dir holds a stored subscription login. */
  hasStoredLogin: boolean;
}

/**
 * Config dirs worth offering: the server default, whatever this process was
 * started with, and any `~/.claude*` directory that actually looks like a
 * Claude Code install. Free-text entry stays available for anything missed.
 */
export async function discoverInstances(
  probe: (dir: string) => Promise<boolean>,
): Promise<DiscoveredInstance[]> {
  const home = os.homedir();
  const origins = new Map<string, DiscoveredInstance['origin']>();

  const note = (dir: string | undefined, origin: DiscoveredInstance['origin']) => {
    const resolved = clean(dir);
    if (resolved && !origins.has(resolved)) origins.set(resolved, origin);
  };

  note(process.env.FOREMAN_CLAUDE_CONFIG_DIR, 'server default');
  note(process.env.CLAUDE_CONFIG_DIR, 'this process');
  note(path.join(home, '.claude'), 'found on disk');

  const entries = await readdir(home, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.claude')) continue;
    note(path.join(home, e.name), 'found on disk');
  }

  const found = await Promise.all(
    [...origins].map(async ([configDir, origin]) => {
      const hasStoredLogin = await probe(configDir);
      // A dir only counts as an install if it holds a login or real settings.
      const looksReal =
        hasStoredLogin || (await stat(path.join(configDir, 'settings.json')).then(() => true, () => false));
      return looksReal || origin !== 'found on disk'
        ? { configDir, origin, hasStoredLogin }
        : null;
    }),
  );

  return found.filter((i): i is DiscoveredInstance => i !== null)
    .sort((a, b) => a.configDir.localeCompare(b.configDir));
}

/**
 * The config dir that will actually apply to an agent — the pin if there is
 * one, otherwise whatever the server process itself resolves to.
 */
export function effectiveConfigDir(instance: ClaudeInstance): string {
  return (
    instance.configDir ??
    clean(process.env.CLAUDE_CONFIG_DIR) ??
    path.join(os.homedir(), '.claude')
  );
}
