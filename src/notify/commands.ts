/**
 * What the linked Telegram chat can say to Foreman besides answering asks.
 *
 * The parser is pure and small on purpose: the phone is the least forgiving
 * place to discover a command's shape, so every command has one shape, a
 * `/help` lists them, and anything that is not a command is treated as talk
 * for the planner of the project last spoken to.
 */
import os from 'node:os';
import path from 'node:path';

export type Command =
  | { cmd: 'help' }
  | { cmd: 'projects' }
  | { cmd: 'status' }
  | { cmd: 'new'; name: string }
  | { cmd: 'plan'; project: string; text: string }
  | { cmd: 'run'; project: string; text: string }
  | { cmd: 'stop'; project?: string };

/** `/plan@ForemanBot test-4 add a footer` → { cmd: 'plan', project: 'test-4', text: 'add a footer' }. */
export function parseCommand(text: string): Command | null {
  const m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] ?? '').trim();
  const split = () => {
    const i = rest.search(/\s/);
    return i < 0 ? [rest, ''] : [rest.slice(0, i), rest.slice(i).trim()];
  };
  switch (cmd) {
    case 'help': case 'start': return { cmd: 'help' };
    case 'projects': case 'ls': return { cmd: 'projects' };
    case 'status': return { cmd: 'status' };
    case 'new': return rest ? { cmd: 'new', name: rest } : null;
    case 'plan': { const [project, t] = split(); return project && t ? { cmd: 'plan', project, text: t } : null; }
    case 'run': { const [project, t] = split(); return project && t ? { cmd: 'run', project, text: t } : null; }
    case 'stop': return { cmd: 'stop', ...(rest ? { project: rest } : {}) };
    default: return null;
  }
}

/** A folder name from whatever was typed: `My New App!` → `my-new-app`. */
export function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
}

/** `~/Projects` → `/Users/me/Projects`; absolute paths pass through. */
export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** The projects root: Settings → Projects → "Projects root", else `~/Projects`. */
export function projectsRoot(settingsRoot: unknown, home = os.homedir()): string {
  const v = typeof settingsRoot === 'string' && settingsRoot.trim() ? settingsRoot.trim() : '~/Projects';
  const abs = expandHome(v, home);
  return path.isAbsolute(abs) ? abs : path.join(home, abs);
}

export const HELP_TEXT = [
  '<b>Foreman</b> — what you can say here',
  '',
  '/projects — the fleet, with what is running',
  '/status — the runs in flight and what they need',
  '/new &lt;name&gt; — create a project under your projects root and link it',
  '/plan &lt;project&gt; &lt;what you want&gt; — talk to that project\'s planner',
  '/run &lt;project&gt; &lt;brief&gt; — skip the talk: start a mission at the project\'s default cap',
  '/stop [project] — stop the planner reply in flight',
  '',
  'Anything else you type answers the open question, or continues the last planning conversation.',
].join('\n');
