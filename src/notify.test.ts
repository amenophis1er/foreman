/**
 * Notifications: what reaches a human, and that nothing else does.
 *
 * The hub is tested with a fake transport because the properties that matter
 * are the hub's — curation, the preference gate, dedupe, editing a message
 * when its subject resolves. Telegram is tested against a stub of its Bot API
 * because the linking flow is the one place a wrong assumption would mean
 * talking to the wrong chat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DEDUPE_TTL_MS, NotifyHub, shape, type Envelope, type Transport } from './notify.js';
import { getMe, linkByCode, telegramTransport } from './notify/telegram.js';

function fakeTransport(name = 'fake') {
  const sent: string[] = [];
  const edits: Array<{ id: string; text: string }> = [];
  let n = 0;
  const t: Transport & { sent: string[]; edits: typeof edits } = {
    name, sent, edits,
    async send(text) { sent.push(text); return String(++n); },
    async edit(id, text) { edits.push({ id, text }); },
  };
  return t;
}

const ctx = (over: Partial<{ needsYou: boolean; done: boolean; budget: boolean }> = {}) => () => ({
  prefs: { needsYou: true, done: true, budget: true, ...over },
  publicUrl: 'http://box.local:4177',
  projectName: (id: string) => (id === 'p1' ? 'shop' : undefined),
  runLabel: (id: string) => (id === 'r1' ? 'Build the checkout page' : undefined),
});

const env = (event: string, data: Record<string, unknown>, extra: Partial<Envelope> = {}): Envelope =>
  ({ event, runId: 'r1', projectId: 'p1', data, ts: 1_000_000, ...extra });

const tick = () => new Promise((r) => setTimeout(r, 5));

test('only events a human should know about are shaped; transcript furniture is not', () => {
  const c = ctx()();
  assert.ok(shape(env('permission_request', { id: 'x', agent: 'director', toolName: 'Bash' }), c));
  assert.ok(shape(env('worker_stalled', { id: 'worker-1', text: 'quiet for 8 minutes' }), c));
  assert.ok(shape(env('run_finished', { status: 'done' }), c));
  assert.equal(shape(env('message', { agent: 'director', msg: {} }), c), null);
  assert.equal(shape(env('cost', { costUsd: 1 }), c), null);
  assert.equal(shape(env('auto_allowed', { toolName: 'Read' }), c), null);
  assert.equal(shape(env('worker_progress', { status: 'building' }), c), null);
});

test('a message names the project, the run, the deadline, and links to the right place', () => {
  const s = shape(env('permission_request', {
    id: 'x', agent: 'director', toolName: 'Write', description: '/Users/x/other/f.txt is outside',
  }), ctx()())!;
  assert.match(s.text, /shop/);
  assert.match(s.text, /Build the checkout page/);
  assert.match(s.text, /Auto-denied if unanswered in 10 min/);
  assert.match(s.text, /http:\/\/box\.local:4177\/#\/p\/p1\/r\/r1/);
  // A planner question links to the project, not to a run it does not have.
  const q = shape(env('chat_question', { id: 'c', questions: [{ question: 'Stack?' }] }, { runId: null, chat: true }), ctx()())!;
  assert.match(q.text, /\/#\/p\/p1"/);
  assert.doesNotMatch(q.text, /\/r\//);
});

test('text from agents is HTML-escaped, so a tool name cannot inject markup', () => {
  const s = shape(env('permission_request', { id: 'x', agent: 'director', toolName: '<b>Bash</b>' }), ctx()())!;
  assert.match(s.text, /&lt;b&gt;Bash&lt;\/b&gt;/);
});

test('the Settings toggles gate the channel exactly as they gate the tab', async () => {
  const t = fakeTransport();
  const hub = new NotifyHub(ctx({ done: false, budget: false }));
  hub.attach(t);
  hub.handle(env('run_finished', { status: 'done' }));
  hub.handle(env('budget_alert', { level: 'reached', text: 'cap' }));
  hub.handle(env('permission_request', { id: 'x', agent: 'director', toolName: 'Bash' }));
  await tick();
  assert.equal(t.sent.length, 1, 'only the needs-you event passes');
  assert.match(t.sent[0], /Needs you/);
});

test('an identical announcement inside the TTL is suppressed; a timeout is not', async () => {
  const t = fakeTransport();
  const hub = new NotifyHub(ctx());
  hub.attach(t);
  hub.handle(env('question', { id: 'q1', question: 'Ship it?' }));
  hub.handle(env('question', { id: 'q1', question: 'Ship it?' }, { ts: 1_000_000 + DEDUPE_TTL_MS / 2 }));
  await tick();
  assert.equal(t.sent.length, 1, 'a re-asking agent gets one tap');
  hub.handle(env('question_timeout', { id: 'q1', afterMs: 600_000 }, { ts: 1_000_000 + 1000 }));
  await tick();
  // Same key, so the outcome edits the original rather than adding a message.
  assert.equal(t.sent.length, 1);
  assert.equal(t.edits.length, 1);
  assert.match(t.edits[0].text, /Auto-answered/);
});

test('when the thing announced resolves, the message is edited, not followed', async () => {
  const t = fakeTransport();
  const hub = new NotifyHub(ctx());
  hub.attach(t);
  hub.handle(env('permission_request', { id: 'p9', agent: 'director', toolName: 'Bash' }));
  await tick();
  hub.handle(env('permission_resolved', { id: 'p9', behavior: 'allow' }));
  await tick();
  assert.equal(t.sent.length, 1);
  assert.equal(t.edits.length, 1);
  assert.equal(t.edits[0].id, '1');
  assert.match(t.edits[0].text, /Needs you[\s\S]*✓ allow/);
  // A resolution for something never announced is silently nothing.
  hub.handle(env('permission_resolved', { id: 'never', behavior: 'deny' }));
  await tick();
  assert.equal(t.edits.length, 1);
});

test('a transport that throws costs a failure count, never an exception on the emitter', async () => {
  const bad: Transport = { name: 'bad', async send() { throw new Error('down'); }, async edit() { throw new Error('down'); } };
  const hub = new NotifyHub(ctx());
  hub.attach(bad);
  assert.doesNotThrow(() => hub.handle(env('run_finished', { status: 'error' })));
  await tick();
  assert.equal(hub.failures, 1);
  assert.equal(hub.delivered, 0);
});

// ---------------------------------------------------------------------------
// Telegram, against a stub of the Bot API
// ---------------------------------------------------------------------------

function stubTelegram(script: { updates?: unknown[][] } = {}) {
  const calls: Array<{ method: string; body: any; token: string }> = [];
  let updateBatch = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ token: m?.[1] ?? '', method: m?.[2] ?? '', body });
      let result: unknown = true;
      if (m?.[2] === 'getMe') result = { username: 'foreman_test_bot' };
      if (m?.[2] === 'sendMessage') result = { message_id: 42 };
      if (m?.[2] === 'getUpdates') result = (script.updates ?? [])[updateBatch++] ?? [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  return new Promise<{ base: string; calls: typeof calls; close(): Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('getMe validates a token and names the bot; a dead endpoint yields null, not a throw', async (t) => {
  const tg = await stubTelegram();
  t.after(() => tg.close());
  assert.deepEqual(await getMe('123:abc', tg.base), { username: 'foreman_test_bot' });
  assert.equal(await getMe('123:abc', 'http://127.0.0.1:1'), null);
});

test('send and edit speak Bot API HTML to the linked chat only', async (t) => {
  const tg = await stubTelegram();
  t.after(() => tg.close());
  const tr = telegramTransport('123:abc', '777', tg.base);
  const id = await tr.send('<b>hi</b>');
  assert.equal(id, '42');
  await tr.edit(id!, 'edited');
  const [send, edit] = tg.calls;
  assert.equal(send.method, 'sendMessage');
  assert.equal(send.body.chat_id, '777');
  assert.equal(send.body.parse_mode, 'HTML');
  assert.equal(edit.method, 'editMessageText');
  assert.equal(edit.body.message_id, 42);
});

test('linking waits for exactly /start <code>; a wrong code from a stranger links nothing', async (t) => {
  const tg = await stubTelegram({ updates: [
    [{ update_id: 1, message: { text: '/start WRONG1', chat: { id: 1, username: 'stranger' } } }],
    [{ update_id: 2, message: { text: 'hello', chat: { id: 2 } } },
     { update_id: 3, message: { text: '/start ABC234', chat: { id: 555, username: 'amen' } } }],
  ] });
  t.after(() => tg.close());
  const link = linkByCode('123:abc', 'ABC234', { apiBase: tg.base, maxMs: 10_000 });
  const got = await link.done;
  assert.deepEqual(got, { chatId: '555', label: '@amen' });
  // The offset advanced past the winning update so it is not replayed later.
  const last = tg.calls.filter((c) => c.method === 'getUpdates').at(-1)!;
  assert.equal(last.body.offset, 4);
});

test('linking gives up at its deadline and can be aborted', async (t) => {
  const tg = await stubTelegram({ updates: [[], [], []] });
  t.after(() => tg.close());
  const link = linkByCode('123:abc', 'ABC234', { apiBase: tg.base, maxMs: 50 });
  assert.equal(await link.done, null);
  const l2 = linkByCode('123:abc', 'ABC234', { apiBase: tg.base, maxMs: 60_000 });
  l2.abort();
  assert.equal(await l2.done, null);
});

test('the deep link opens the bot with the code pre-filled, whatever form the username took', async () => {
  const { telegramStartLink } = await import('./notify/telegram.js');
  assert.equal(telegramStartLink('@ForemanAgentBot', 'W55TMZ'), 'https://t.me/ForemanAgentBot?start=W55TMZ');
  assert.equal(telegramStartLink('ForemanAgentBot', 'W55TMZ'), 'https://t.me/ForemanAgentBot?start=W55TMZ');
  // Telegram delivers that payload as the message "/start W55TMZ" — exactly
  // what linkByCode waits for, so scanning is the same act as typing.
});

// ---------------------------------------------------------------------------
// Phase B: answering from the channel
// ---------------------------------------------------------------------------

function buttonTransport() {
  const t = fakeTransport('tg') as ReturnType<typeof fakeTransport> & { buttons: Array<unknown> ; editButtons: Array<unknown> };
  t.buttons = []; t.editButtons = [];
  const send = t.send.bind(t), edit = t.edit.bind(t);
  t.send = async (text, opts) => { t.buttons.push(opts?.buttons ?? null); return send(text); };
  t.edit = async (id, text, opts) => { t.editButtons.push(opts?.buttons ?? null); return edit(id, text); };
  return t;
}

test('an approval carries Allow/Deny buttons, and a tap resolves it — never "always"', async () => {
  const t = buttonTransport();
  const answers: unknown[] = [];
  const hub = new NotifyHub(ctx()); hub.attach(t); hub.onAnswer((a) => answers.push(a));
  hub.handle(env('permission_request', { id: 'toolu_1', agent: 'director', toolName: 'Bash' }));
  await tick();
  const rows = t.buttons[0] as Array<Array<{ label: string; data: string }>>;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].map((b) => b.data), ['p|toolu_1|allow', 'p|toolu_1|deny']);
  assert.ok(rows.flat().every((b) => !/always/i.test(b.label)));
  assert.equal(hub.handleCallback('p|toolu_1|deny', '1'), true);
  assert.deepEqual(answers, [{ kind: 'perm', id: 'toolu_1', behavior: 'deny' }]);
});

test('a forged or stale tap is ignored', () => {
  const hub = new NotifyHub(ctx()); hub.attach(fakeTransport());
  assert.equal(hub.handleCallback('p|nope|allow'), false);
  assert.equal(hub.handleCallback('garbage'), false);
  assert.equal(hub.handleCallback('cq|nope|0|0'), false);
});

test('planner questions step through one message; the last tap answers them all', async () => {
  const t = buttonTransport();
  const answers: unknown[] = [];
  const hub = new NotifyHub(ctx()); hub.attach(t); hub.onAnswer((a) => answers.push(a));
  hub.handle(env('chat_question', { id: 'q-1', questions: [
    { question: 'Stack?', options: [{ label: 'Static HTML' }, { label: 'React' }] },
    { question: 'Imagery?', options: [{ label: 'Stock photos', hint: 'Unsplash' }, { label: 'Placeholders' }] },
  ] }, { runId: null, chat: true }));
  await tick();
  assert.match(t.sent[0], /1\/2/);
  const first = t.buttons[0] as Array<Array<{ data: string; label: string }>>;
  assert.deepEqual(first.map((r) => r[0].data), ['cq|q-1|0|0', 'cq|q-1|0|1']);
  assert.match(first[0][0].label, /★/, 'the recommended option is starred');

  // A tap on step 2's buttons before step 2 exists is stale and ignored.
  assert.equal(hub.handleCallback('cq|q-1|1|0', '1'), false);
  // Tap step 1 → the message is edited to step 2 with step 2's buttons.
  assert.equal(hub.handleCallback('cq|q-1|0|1', '1'), true);
  await tick();
  assert.equal(answers.length, 0, 'not answered until every question has a value');
  assert.match(t.edits.at(-1)!.text, /✓ Stack\? → <b>React<\/b>[\s\S]*2\/2[\s\S]*Imagery\?/);
  const second = t.editButtons.at(-1) as Array<Array<{ data: string }>>;
  assert.deepEqual(second.map((r) => r[0].data), ['cq|q-1|1|0', 'cq|q-1|1|1']);
  // Tap step 2 → the whole set is answered, in the picker's shape.
  hub.handleCallback('cq|q-1|1|0', '1');
  assert.deepEqual(answers, [{ kind: 'cq', projectId: 'p1', id: 'q-1', answers: { 'Stack?': 'React', 'Imagery?': 'Stock photos' } }]);
});

test('a typed reply is the picker’s "something else", and a director question takes free text', async () => {
  const answers: unknown[] = [];
  const hub = new NotifyHub(ctx()); hub.attach(fakeTransport()); hub.onAnswer((a) => answers.push(a));
  hub.handle(env('question', { id: 'dq', question: 'Ship to prod?' }));
  await tick();
  assert.equal(hub.handleText('  yes, but after the tests  '), true);
  assert.deepEqual(answers.at(-1), { kind: 'q', id: 'dq', text: 'yes, but after the tests' });
  // With nothing pending, text is not an answer to anything.
  assert.equal(hub.handleText('hello?'), false);
});

test('the bot dispatches taps and texts from the linked chat only, and acknowledges every tap', async (t) => {
  const { TelegramBot } = await import('./notify/telegram.js');
  const tg = await stubTelegram({ updates: [[
    { update_id: 10, callback_query: { id: 'cb1', data: 'p|x|allow', from: { id: 999 }, message: { message_id: 5, chat: { id: 999 } } } },
    { update_id: 11, callback_query: { id: 'cb2', data: 'p|x|deny', from: { id: 555 }, message: { message_id: 6, chat: { id: 555 } } } },
    { update_id: 12, message: { message_id: 7, text: 'from a stranger', chat: { id: 999 } } },
    { update_id: 13, message: { message_id: 8, text: 'from me', chat: { id: 555 }, reply_to_message: { message_id: 6 } } },
  ]] });
  t.after(() => tg.close());
  const taps: unknown[] = []; const texts: unknown[] = [];
  const bot = new TelegramBot('123:abc', tg.base, '555', {
    onCallback: (d, m) => taps.push([d, m]), onText: (x, r) => texts.push([x, r]),
  });
  bot.start();
  for (let i = 0; i < 40 && taps.length + texts.length < 2; i++) await tick();
  bot.stop();
  assert.deepEqual(taps, [['p|x|deny', '6']], 'only the linked chat’s tap is dispatched');
  assert.deepEqual(texts, [['from me', '6']]);
  const acks = tg.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.callback_query_id);
  assert.deepEqual(acks.sort(), ['cb1', 'cb2'], 'a stranger’s tap is acknowledged too, so their spinner stops');
});
