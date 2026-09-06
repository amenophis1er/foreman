/**
 * Telegram — the first channel, chosen because it needs no credential minted.
 *
 * The human creates a bot with @BotFather and pastes its token; Foreman keeps
 * that in the secret store at 0600, like a provider key, and never returns
 * it. Linking is a one-time code: Foreman shows `/start <code>` (and a QR of
 * the t.me deep link that pre-fills it), the human sends it to their bot, and
 * the chat that sent it is the one Foreman talks to. No OAuth, no public URL
 * — updates are read by long-polling `getUpdates`, which works from a laptop
 * behind NAT, where a webhook would not.
 *
 * ONE POLLER. Telegram allows a single `getUpdates` consumer per bot; two
 * concurrent pollers get 409s and lose messages between them. So a bot has
 * exactly one {@link TelegramBot}, which reads everything — link codes,
 * button taps, text replies — and dispatches. Linking, answering and the
 * transport all hang off it.
 *
 * Everything here swallows transport errors. A dead channel is a lost tap on
 * the shoulder; it must never become a failed run.
 */
import type { Button, Transport } from '../notify.js';

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

const keyboard = (buttons?: Button[][]) => buttons?.length
  ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data.slice(0, 64) }))) } }
  : {};

/** A Telegram chat as a Transport. HTML parse mode; previews off so links stay one line. */
export function telegramTransport(token: string, chatId: string, apiBase = TELEGRAM_API): Transport {
  return {
    name: 'telegram',
    async send(text, opts) {
      const m = await call<{ message_id: number }>(apiBase, token, 'sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...keyboard(opts?.buttons),
      });
      return m ? String(m.message_id) : null;
    },
    async edit(id, text, opts) {
      // No reply_markup in the body means Telegram removes the keyboard — an
      // answered question offers nothing to tap.
      await call(apiBase, token, 'editMessageText', {
        chat_id: chatId, message_id: Number(id), text, parse_mode: 'HTML', disable_web_page_preview: true,
        ...(opts?.buttons ? keyboard(opts.buttons) : { reply_markup: { inline_keyboard: [] } }),
      });
    },
  };
}

/**
 * The deep link that opens the bot with `/start <code>` pre-filled.
 *
 * Telegram delivers the `start` payload as exactly the message the poller
 * waits for, so a QR of this URL turns linking into one scan and one tap —
 * no typing a code on a phone. Only the bot's username is public here; the
 * code is single-use and expires, which is why it is safe on a screen.
 */
/** The "/" menu on the phone. Registered on every start, so the list is never behind the code. */
export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'projects', description: 'The fleet, with what is running' },
  { command: 'status', description: 'Runs in flight, spend, what needs you' },
  { command: 'new', description: 'Create a project: /new <name>' },
  { command: 'plan', description: 'Talk to a planner: /plan <project> <what you want>' },
  { command: 'run', description: 'Skip the talk: /run <project> <brief>' },
  { command: 'stop', description: 'Stop the planner reply in flight' },
  { command: 'help', description: 'What you can say here' },
];

export async function setBotCommands(token: string, apiBase = TELEGRAM_API): Promise<boolean> {
  try { await call(apiBase, token, 'setMyCommands', { commands: BOT_COMMANDS }, 10_000); return true; }
  catch { return false; }
}

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

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number; text?: string;
    chat: { id: number; username?: string; first_name?: string; title?: string };
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string; data?: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
}

export interface BotHandlers {
  /** A tap on an inline button, from the linked chat only. */
  onCallback?: (data: string, messageId: string) => void;
  /** A text message, from the linked chat only. */
  onText?: (text: string, replyToMessageId?: string) => void;
}

/**
 * The one reader of a bot's updates.
 *
 * `linkedChatId` is the only chat whose taps and texts are dispatched; a
 * message from anyone else is dropped unless it is a `/start <code>` for a
 * code currently being waited on — the only way in, and it needs the code
 * shown on the human's own screen.
 */
export class TelegramBot {
  private stopped = false;
  private offset: number | undefined;
  private links = new Map<string, { resolve: (c: LinkedChat) => void; deadline: number }>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly token: string,
    private readonly apiBase = TELEGRAM_API,
    public linkedChatId: string | null = null,
    private handlers: BotHandlers = {},
  ) {}

  setHandlers(h: BotHandlers): void { this.handlers = h; }

  /** Begin polling; idempotent. */
  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = this.loop().finally(() => { this.running = null; });
  }

  /**
   * Stop reading, and tell Telegram what was consumed. Without the final
   * zero-timeout `getUpdates` carrying the advanced offset, the next reader
   * on this token would be handed the same updates again — a link code that
   * already linked, a tap that already resolved.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.offset !== undefined) {
      await call(this.apiBase, this.token, 'getUpdates', { offset: this.offset, timeout: 0 }, 5_000);
    }
  }

  /**
   * Wait for `/start <code>`; resolves with the chat that sent it, or null at
   * the deadline. Several codes may wait at once; the newest one from the
   * Settings panel is the one the human sees, and an old code someone else
   * happened to have still only links if it has not expired.
   */
  link(code: string, maxMs = 10 * 60_000): { done: Promise<LinkedChat | null>; abort(): void } {
    let settle: (c: LinkedChat | null) => void = () => {};
    const done = new Promise<LinkedChat | null>((r) => { settle = r; });
    const key = code.toLowerCase();
    this.links.set(key, { resolve: (c) => { this.links.delete(key); settle(c); }, deadline: Date.now() + maxMs });
    const timer = setTimeout(() => { if (this.links.delete(key)) settle(null); }, maxMs);
    (timer as { unref?: () => void }).unref?.();
    this.start();
    return { done, abort: () => { if (this.links.delete(key)) settle(null); clearTimeout(timer); } };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const updates = await call<TgUpdate[]>(this.apiBase, this.token, 'getUpdates', {
        timeout: 25, offset: this.offset, allowed_updates: ['message', 'callback_query'],
      }, 35_000);
      if (this.stopped) return;
      if (!updates) { await new Promise((r) => setTimeout(r, 2_000)); continue; }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try { await this.dispatch(u); } catch { /* one bad update must not stop the reader */ }
      }
    }
  }

  private async dispatch(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      const cq = u.callback_query;
      const chat = String(cq.message?.chat.id ?? cq.from.id);
      // Always acknowledge, so the phone's spinner stops — even for a tap we
      // then ignore because it came from a chat that is not the linked one.
      await call(this.apiBase, this.token, 'answerCallbackQuery', { callback_query_id: cq.id }, 5_000);
      if (this.linkedChatId && chat === this.linkedChatId && cq.data) {
        this.handlers.onCallback?.(cq.data, String(cq.message?.message_id ?? ''));
      }
      return;
    }
    const m = u.message;
    if (!m) return;
    const chat = String(m.chat.id);
    const text = (m.text ?? '').trim();

    const start = /^\/start(?:@\w+)?\s+(\S+)/i.exec(text);
    if (start) {
      const want = this.links.get(start[1].toLowerCase());
      if (want && want.deadline > Date.now()) {
        this.linkedChatId = chat;
        want.resolve({ chatId: chat, label: m.chat.username ? `@${m.chat.username}` : (m.chat.first_name ?? m.chat.title ?? chat) });
      }
      return;
    }
    if (this.linkedChatId && chat === this.linkedChatId && text) {
      this.handlers.onText?.(text, m.reply_to_message ? String(m.reply_to_message.message_id) : undefined);
    }
  }
}

/**
 * Compatibility: wait for a link code with a poller of its own. Only for a
 * bot that has no running {@link TelegramBot} — two pollers on one token
 * conflict. The server uses `bot.link(code)` instead.
 */
export function linkByCode(
  token: string, code: string,
  opts: { apiBase?: string; maxMs?: number } = {},
): { done: Promise<LinkedChat | null>; abort(): void } {
  const bot = new TelegramBot(token, opts.apiBase ?? TELEGRAM_API);
  const l = bot.link(code, opts.maxMs);
  // The ack is awaited before `done` resolves, so a caller that starts a new
  // reader right after is not handed the code message again.
  const done = l.done.then(async (c) => { await bot.stop(); return c; });
  return { done, abort: () => { l.abort(); void bot.stop(); } };
}
