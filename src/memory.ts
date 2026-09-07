/**
 * Project memory: the page of notes a good contractor keeps about a site.
 *
 * `.foreman/MEMORY.md` — one file per project, human-readable, a page or two
 * at most. How to run the tests, which port is taken, where the CSS lives
 * and why, what the client hates. Read by the director, the workers and the
 * planner at the start of every turn; written by the director at the end of
 * a mission through one tool; visible in the rail so the human can see what
 * their project "believes", and edit it with any text editor.
 *
 * Memory makes the crew better informed, never more powerful: it is prose
 * in a prompt, and everything the crew may do is still exactly what the
 * tool policy and the budget allow. It also never carries a secret — the
 * server strips anything that looks like one before writing.
 */
import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

export const MEMORY_FILE = '.foreman/MEMORY.md';
/** Bytes kept in the file. Past this the director is asked to prune, not append. */
export const MEMORY_CAP_BYTES = 8 * 1024;
/** Bytes injected into a prompt; the tail is dropped with a note if the file is larger. */
const INJECT_CAP_BYTES = 6 * 1024;

export function memoryPath(folder: string): string {
  return path.join(folder, MEMORY_FILE);
}

export async function readMemory(folder: string): Promise<{ text: string; updatedAt?: number }> {
  const file = memoryPath(folder);
  const text = await readFile(file, 'utf8').catch(() => '');
  const st = text ? await stat(file).catch(() => null) : null;
  return { text, updatedAt: st?.mtimeMs };
}

/**
 * Things that must not live in a page of notes, whatever the model meant:
 * API keys, tokens, private keys, and `KEY=value` lines for secret-looking
 * names. Replaced, not dropped, so the line still reads as a line.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|rk|pk)-(?:live|test|proj|ant)?-?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"']{8,}["']?/gi,
  /\b(?:bearer|token|password|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/gi,
];

/** Strip what looks like a credential. Returns the text and how many replacements were made. */
export function scrubSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, name?: string) => {
      redacted += 1;
      // Keep the variable name when there was one, so the line still explains itself.
      return typeof name === 'string' && /^[A-Z0-9_]+$/.test(name) && m.startsWith(name) ? `${name}=[redacted]` : '[redacted]';
    });
  }
  return { text: out, redacted };
}

/**
 * Write the whole memory. The director hands over the full page, not a
 * delta, because "rewrite the stale line" is the behaviour we want and
 * append-only files only grow. Trimmed to the cap; the caller is told.
 */
export async function writeMemory(folder: string, text: string): Promise<{ bytes: number; redacted: number; trimmed: boolean }> {
  const scrubbed = scrubSecrets(text.replace(/\r\n/g, '\n').trim());
  let body = scrubbed.text;
  let trimmed = false;
  if (Buffer.byteLength(body, 'utf8') > MEMORY_CAP_BYTES) {
    body = Buffer.from(body, 'utf8').subarray(0, MEMORY_CAP_BYTES).toString('utf8').replace(/[^\n]*$/, '').trimEnd();
    trimmed = true;
  }
  await mkdir(path.dirname(memoryPath(folder)), { recursive: true });
  await writeFile(memoryPath(folder), body ? `${body}\n` : '');
  return { bytes: Buffer.byteLength(body, 'utf8'), redacted: scrubbed.redacted, trimmed };
}

/**
 * The memory as a prompt section, for the director, the workers and the
 * planner. Empty memory says so in one line rather than vanishing, so the
 * crew knows the file exists to be written.
 */
export function memorySection(text: string, role: 'director' | 'worker' | 'planner'): string {
  const t = text.trim();
  if (!t) {
    return role === 'director'
      ? `\nPROJECT MEMORY (${MEMORY_FILE}): empty. Before you finish, write it with mcp__foreman__remember — a page at most of facts the next crew needs here.\n`
      : '';
  }
  let body = t;
  if (Buffer.byteLength(body, 'utf8') > INJECT_CAP_BYTES) {
    body = Buffer.from(body, 'utf8').subarray(0, INJECT_CAP_BYTES).toString('utf8').replace(/[^\n]*$/, '') + '\n[… memory is longer than a page; the rest was not shown. Prune it.]';
  }
  const lead = role === 'director'
    ? `PROJECT MEMORY (${MEMORY_FILE}) — what earlier crews learned about this project. Trust it over guessing; correct it when it is wrong. Before you finish, rewrite it with mcp__foreman__remember so the next crew starts where you end.`
    : role === 'worker'
      ? 'PROJECT MEMORY — what earlier crews learned about this project. Trust it over guessing; tell the director if it is wrong.'
      : `PROJECT MEMORY (${MEMORY_FILE}) — what the crew learned about this project on earlier missions. Ground your advice in it, and say when a proposal would change something it records.`;
  return `\n${lead}\n---\n${body}\n---\n`;
}
