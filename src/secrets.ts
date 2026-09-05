/**
 * Provider keys, kept on disk.
 *
 * This is the first thing Foreman is custodian of. Everything else it
 * authenticates with belongs to somebody else's CLI — `~/.claude`,
 * `~/.codex` — and the standing rule in docs/provider-model.md §5 is to read
 * what a first-party tool already wrote rather than mint anything. That rule
 * survives: it is about *minting*, not storing, and it still decides the
 * default. Lean on a CLI wherever one exists; store a key only where there is
 * none to lean on — OpenAI, OpenRouter, a self-hosted endpoint.
 *
 * Rules this module exists to keep:
 *
 *  - A key lives in the provider's own Foreman-owned config dir, mode 0600,
 *    and nowhere else. Never in `projects.json`, which is world-readable
 *    ordinary config people copy between machines and paste into issues.
 *  - No route ever returns one. The API answers "is there a key" and nothing
 *    more, so a compromised browser session cannot read out what it can only
 *    replace.
 *  - Nothing here logs, throws with, or embeds a key in an error message.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ownedConfigDir } from './provider.js';

/** Mode 0600: readable by the user who runs Foreman, nobody else. */
const KEY_MODE = 0o600;

function keyFile(root: string, providerId: string): string {
  return path.join(ownedConfigDir(root, providerId), 'key');
}

/**
 * Stores a provider's key, replacing any previous one.
 *
 * Written tmp-then-rename like every other file Foreman owns, but with the
 * mode set *before* the rename: creating the real file world-readable and
 * tightening it afterwards leaves a window where it is not.
 */
export async function putSecret(root: string, providerId: string, key: string): Promise<void> {
  const file = keyFile(root, providerId);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.key.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, key, { mode: KEY_MODE });
  await chmod(tmp, KEY_MODE);
  await rename(tmp, file);
}

/** The stored key, or null. The only function that returns one. */
export async function getSecret(root: string, providerId: string): Promise<string | null> {
  const raw = await readFile(keyFile(root, providerId), 'utf8').catch(() => null);
  const key = raw?.trim();
  return key ? key : null;
}

/** Whether a key is stored — what the API is allowed to say. */
export async function hasSecret(root: string, providerId: string): Promise<boolean> {
  return stat(keyFile(root, providerId)).then((st) => st.isFile(), () => false);
}

/** Forgets a provider's key. Absent is success: the caller wanted it gone. */
export async function deleteSecret(root: string, providerId: string): Promise<void> {
  await rm(keyFile(root, providerId), { force: true });
}
