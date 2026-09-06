/**
 * Shell completion for the `foreman` command.
 *
 * `foreman completion <shell>` prints a script; `foreman completion install`
 * wires it into the shell's rc file, once, behind a marker — the only file
 * outside ~/.foreman the CLI ever writes, and only when asked by name.
 */
import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

export type Shell = 'zsh' | 'bash' | 'fish';

/** Every top-level command with the one line the menu shows for it. Keep in step with bin/foreman.mjs USAGE. */
export const COMMANDS: Array<[string, string]> = [
  ['start', 'Start in this terminal'],
  ['up', 'Start in the background'],
  ['stop', 'Stop it, however it was started'],
  ['restart', 'Stop and start it again the same way'],
  ['status', 'Is a server up, on which port, started how'],
  ['logs', 'Tail the log'],
  ['open', 'Open the dashboard in your browser'],
  ['doctor', 'Check credentials, providers, browser, port, Tailscale'],
  ['update', 'Install the latest version and restart'],
  ['service', 'Keep Foreman running at login'],
  ['uninstall', 'Remove the service and the background server'],
  ['completion', 'Shell completion: zsh, bash, fish, or install'],
  ['help', 'Show usage'],
  ['version', 'Print the version'],
];
export const SERVICE_COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'];
export const COMPLETION_ARGS = ['zsh', 'bash', 'fish', 'install'];
const FLAGS: Record<string, string[]> = { update: ['--force'], uninstall: ['--purge', '--yes'] };

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function completionScript(shell: Shell): string {
  const names = COMMANDS.map(([c]) => c).join(' ');
  if (shell === 'zsh') {
    return [
      '#compdef foreman',
      '_foreman() {',
      '  local -a cmds',
      `  cmds=(${COMMANDS.map(([c, d]) => q(`${c}:${d}`)).join(' ')})`,
      '  if (( CURRENT == 2 )); then _describe -t commands "foreman command" cmds; return; fi',
      '  case "${words[2]}" in',
      `    service) local -a svc; svc=(${SERVICE_COMMANDS.map(q).join(' ')}); _describe -t commands "service command" svc ;;`,
      `    completion) local -a sh; sh=(${COMPLETION_ARGS.map(q).join(' ')}); _describe -t commands "shell" sh ;;`,
      ...Object.entries(FLAGS).map(([c, f]) => `    ${c}) local -a fl; fl=(${f.map(q).join(' ')}); _describe -t options "flag" fl ;;`),
      '  esac',
      '}',
      'compdef _foreman foreman',
      '',
    ].join('\n');
  }
  if (shell === 'bash') {
    return [
      '_foreman() {',
      '  local cur prev',
      '  cur="${COMP_WORDS[COMP_CWORD]}"',
      '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
      `  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "${names}" -- "$cur") ); return; fi`,
      '  case "$prev" in',
      `    service) COMPREPLY=( $(compgen -W "${SERVICE_COMMANDS.join(' ')}" -- "$cur") ) ;;`,
      `    completion) COMPREPLY=( $(compgen -W "${COMPLETION_ARGS.join(' ')}" -- "$cur") ) ;;`,
      ...Object.entries(FLAGS).map(([c, f]) => `    ${c}) COMPREPLY=( $(compgen -W "${f.join(' ')}" -- "$cur") ) ;;`),
      '  esac',
      '}',
      'complete -F _foreman foreman',
      '',
    ].join('\n');
  }
  return [
    'complete -c foreman -f',
    ...COMMANDS.map(([c, d]) => `complete -c foreman -n __fish_use_subcommand -a ${c} -d ${q(d)}`),
    `complete -c foreman -n '__fish_seen_subcommand_from service' -a '${SERVICE_COMMANDS.join(' ')}'`,
    `complete -c foreman -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_ARGS.join(' ')}'`,
    ...Object.entries(FLAGS).flatMap(([c, f]) => f.map((flag) => `complete -c foreman -n '__fish_seen_subcommand_from ${c}' -l ${flag.replace(/^--/, '')}`)),
    '',
  ].join('\n');
}

/** The user's shell from $SHELL, or null when it is none of the three. */
export function detectShell(env: NodeJS.ProcessEnv = process.env): Shell | null {
  const name = path.basename(env.SHELL ?? '');
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : null;
}

const MARKER = '# foreman completion';

/**
 * Where the hook goes, and what it is. zsh and bash source the script at
 * shell start; fish loads a file from its completions directory on demand.
 */
export function installTarget(shell: Shell, home = os.homedir()): { file: string; line?: string } {
  if (shell === 'fish') return { file: path.join(home, '.config', 'fish', 'completions', 'foreman.fish') };
  const file = shell === 'zsh' ? path.join(home, '.zshrc') : path.join(home, '.bashrc');
  return { file, line: `eval "$(foreman completion ${shell})" ${MARKER}` };
}

/** Idempotent: a second install finds the marker and changes nothing. Returns what happened. */
export async function installCompletion(shell: Shell, home = os.homedir()): Promise<string> {
  const target = installTarget(shell, home);
  if (!target.line) {
    await mkdir(path.dirname(target.file), { recursive: true });
    await writeFile(target.file, completionScript('fish'));
    return `Wrote ${target.file}. Open a new fish shell.`;
  }
  const current = await readFile(target.file, 'utf8').catch(() => '');
  if (current.includes(MARKER)) return `Already installed in ${target.file}.`;
  await appendFile(target.file, `${current.endsWith('\n') || !current ? '' : '\n'}${target.line}\n`);
  return `Added one line to ${target.file}. Open a new shell, or run: source ${target.file}`;
}
