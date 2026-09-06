/**
 * Files a person hands to the planner or the director: a screenshot of the
 * bug, a spec, a CSV. They land in the project folder — `.foreman/attachments/`
 * — because that is the one place both the planner (read-only) and the crew
 * can reach without any new permission, and the message that carries them
 * names the paths. The folder self-ignores in git, so nothing leaks into the
 * user's history. Files, not blobs in a database: the deck lists them as
 * artifacts, and the human can find them with a file manager.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ATTACHMENTS_DIR = path.join('.foreman', 'attachments');
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export interface IncomingAttachment { name: string; data: string /* base64 */; type?: string }
export interface SavedAttachment { path: string; size: number; name: string }

/** A file name the filesystem and a shell both accept, keeping the extension. */
export function safeName(name: string): string {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '');
  return base && base !== '.' && base !== '..' ? base.slice(0, 120) : 'file';
}

/** `20260905-194412-` — sortable, unique enough for a human's pace, readable. */
function stamp(d = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Writes the files under the folder and returns their project-relative
 * paths. Throws with a plain message on anything a person can fix (too many,
 * too big, empty), so the route can hand it back as a 400.
 */
export async function saveAttachments(folder: string, files: IncomingAttachment[], now = new Date()): Promise<SavedAttachment[]> {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} files per message`);
  const dir = path.join(folder, ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });
  const out: SavedAttachment[] = [];
  const prefix = stamp(now);
  for (const [i, f] of files.entries()) {
    if (!f || typeof f.data !== 'string') throw new Error('each file needs base64 data');
    const buf = Buffer.from(f.data, 'base64');
    if (buf.length === 0) throw new Error(`${f.name || 'a file'} is empty`);
    if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error(`${f.name || 'a file'} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    const name = `${prefix}${files.length > 1 ? `-${i + 1}` : ''}-${safeName(f.name)}`;
    await writeFile(path.join(dir, name), buf, { flag: 'wx' });
    out.push({ path: path.posix.join('.foreman', 'attachments', name), size: buf.length, name: safeName(f.name) });
  }
  return out;
}

/** The lines appended to a message so an agent knows what came with it. */
export function attachmentLines(saved: SavedAttachment[]): string {
  if (!saved.length) return '';
  return '\n\nAttached files (in the project folder — read them):\n' + saved.map((s) => `- ${s.path}`).join('\n');
}
