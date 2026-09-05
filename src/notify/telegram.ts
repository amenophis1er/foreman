/**
 * Telegram — the first channel, chosen because it needs no credential minted.
 *
 * The human creates a bot with @BotFather and pastes its token; Foreman keeps
 * that in the secret store at 0600, like a provider key, and never returns
 * it. Linking is a one-time code: Foreman shows `/start <code>`, the human
 * sends it to their bot, and the chat id that sent it is the one Foreman
 * will talk to. No OAuth, no public URL — updates are read by long-polling
 * `getUpdates`, which works from a laptop behind NAT, where a webhook would
 * not.
 *
 * Everything here swallows transport errors. A dead channel is a lost tap on
 * the shoulder; it must never become a failed run.
 */
import type { Transport } from '../notify.js';

export const TELEGRAM_API = 'https://api.telegram.org';

interface TgResponse<T> { ok: boolean; result?: T; description?: string }

async function call<T>(
  apiBase: string, token: string, method: string, body: Record<string, unknown>, timeoutMs = 15_000,
): Promise<T | null> {
  try {
    const r = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null) as TgResponse<T> | null;
    return j?.ok ? (j.result as T) : null;
  } catch {
    return null;
  }
}

/** The bot's own identity, used to validate a pasted token and to show whose bot this is. */
export async function getMe(token: string, apiBase = TELEGRAM_API): Promise<{ username: string } | null> {
  const me = await call<{ username?: string }>(apiBase, token, 'getMe', {}, 8_000);
  return me?.username ? { username: me.username } : null;
}

/** A Telegram chat as a Transport. HTML parse mode; previews off so links stay one line. */
export function telegramTransport(token: string, chatId: string, apiBase = TELEGRAM_API): Transport {
  return {
    name: 'telegram',
    async send(text: string): Promise<string | null> {
      const m = await call<{ message_id: number }>(apiBase, token, 'sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
      });
      return m ? String(m.message_id) : null;
    },
    async edit(id: string, text: string): Promise<void> {
      await call(apiBase, token, 'editMessageText', {
        chat_id: chatId, message_id: Number(id), text, parse_mode: 'HTML', disable_web_page_preview: true,
      });
    },
  };
}

/**
 * The deep link that opens the bot with `/start <code>` pre-filled.
 *
 * Telegram delivers the `start` payload as exactly the message `linkByCode`
 * waits for, so a QR of this URL turns linking into one scan and one tap —
 * no typing a code on a phone. Only the bot's username is public here; the
 * code is single-use and expires, which is why it is safe on a screen.
 */
export function telegramStartLink(bot: string, code: string): string {
  return `https://t.me/${bot.replace(/^@/, '')}?start=${encodeURIComponent(code)}`;
}

/** Six characters from an alphabet with no look-alikes: typed on a phone, read off a screen. */
export function linkCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export interface LinkedChat {
  chatId: string;
  /** Who linked: a username or first name, for the Settings panel to show. */
  label: string;
}

/**
 * Waits for `/start <code>` from any chat and resolves with that chat.
 *
 * Long-polls with Telegram's own `timeout`, so it costs one open request per
 * ~25 s rather than a tight loop. Gives up after `maxMs`; the human can ask
 * for a new code. Messages that are not the code are ignored — including a
 * wrong code, which is the only defence needed against someone else finding
 * the bot: without the code shown on the human's screen, nothing links.
 */
export function linkByCode(
  token: string, code: string,
  opts: { apiBase?: string; maxMs?: number } = {},
): { done: Promise<LinkedChat | null>; abort(): void } {
  const apiBase = opts.apiBase ?? TELEGRAM_API;
  const deadline = Date.now() + (opts.maxMs ?? 10 * 60_000);
  let stopped = false;
  let offset: number | undefined;
  const want = `/start ${code}`.toLowerCase();

  const done = (async (): Promise<LinkedChat | null> => {
    while (!stopped && Date.now() < deadline) {
      const updates = await call<Array<{
        update_id: number;
        message?: { text?: string; chat: { id: number; username?: string; first_name?: string; title?: string } };
      }>>(apiBase, token, 'getUpdates', {
        timeout: 25, offset, allowed_updates: ['message'],
      }, 35_000);
      if (!updates) { await new Promise((r) => setTimeout(r, 2_000)); continue; }
      for (const u of updates) {
        offset = u.update_id + 1;
        const text = (u.message?.text ?? '').trim().toLowerCase();
        if (text === want && u.message) {
          const c = u.message.chat;
          // Acknowledge the offset so the code message is not re-delivered to
          // the next linking attempt, then answer in the chat itself.
          await call(apiBase, token, 'getUpdates', { offset, timeout: 0 }, 5_000);
          return { chatId: String(c.id), label: c.username ? `@${c.username}` : (c.first_name ?? c.title ?? String(c.id)) };
        }
      }
    }
    return null;
  })();

  return { done, abort() { stopped = true; } };
}
