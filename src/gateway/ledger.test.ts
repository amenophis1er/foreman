/**
 * The gateway's token ledger.
 *
 * What is under test is an observation that must never affect what it
 * observes: the response an agent receives has to be byte-identical whether
 * or not anyone is counting, and a request that cannot be attributed must
 * still be served. The counting itself is second to that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const ledgerMod = require_('./ledger.cjs') as {
  extractUsage(body: string): { usage: Record<string, number>; costUsd?: number } | null;
  record(key: string, usage: unknown, costUsd?: number): void;
  ledger: Map<string, Record<string, number>>;
};
const gateway = require_('./llm-gateway.cjs') as Record<string, unknown>;

test('the ported handlers are exported, which is what lets the socket be wrapped', () => {
  // A divergence from the verbatim upstream copy. If a re-sync drops it, the
  // wrapper cannot bind the socket and every gateway run stops being counted
  // — silently, which is why this is asserted rather than assumed.
  for (const name of ['handleOpenAI', 'handleCodex', 'handlePassthrough']) {
    assert.equal(typeof gateway[name], 'function', `${name} must stay exported`);
  }
});

test('usage is read from a single JSON response', () => {
  const got = ledgerMod.extractUsage(JSON.stringify({
    type: 'message', usage: { input_tokens: 120, output_tokens: 34 },
  }));
  assert.equal(got?.usage.input_tokens, 120);
  assert.equal(got?.usage.output_tokens, 34);
});

test('usage is read from the closing frame of a stream, not an earlier one', () => {
  // An OpenAI-compatible endpoint reports usage only at the end, and the
  // gateway's `message_start` carries zeros. Taking the first match would
  // record nothing for every streamed response there is.
  const body = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}',
    '',
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
    '',
    'data: {"type":"message_delta","usage":{"input_tokens":9001,"output_tokens":42}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const got = ledgerMod.extractUsage(body);
  assert.equal(got?.usage.input_tokens, 9001);
  assert.equal(got?.usage.output_tokens, 42);
});

test('a body with no usage, or a torn one, yields nothing rather than throwing', () => {
  assert.equal(ledgerMod.extractUsage('{"type":"message"}'), null);
  assert.equal(ledgerMod.extractUsage('not json at all'), null);
  assert.equal(ledgerMod.extractUsage(''), null);
  // A stream cut mid-frame: the complete frames before it still count.
  const torn = 'data: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":1}}\n\ndata: {"typ';
  assert.equal(ledgerMod.extractUsage(torn)?.usage.input_tokens, 5);
});

test('an upstream-reported cost is carried, and never invented', () => {
  // OpenRouter states `usage.cost` per response. Where it does, that is the
  // truthful figure; where it does not, the ledger leaves the field absent
  // rather than deriving one.
  const withCost = ledgerMod.extractUsage(JSON.stringify({
    usage: { input_tokens: 1, output_tokens: 1, cost: 0.00042 },
  }));
  assert.equal(withCost?.costUsd, 0.00042);
  const without = ledgerMod.extractUsage(JSON.stringify({
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  assert.equal(without?.costUsd, undefined);
});

test('totals accumulate per key, and keys do not bleed into each other', () => {
  ledgerMod.ledger.clear();
  ledgerMod.record('run-a.0', { input_tokens: 100, output_tokens: 10 });
  ledgerMod.record('run-a.0', { input_tokens: 50, output_tokens: 5 });
  ledgerMod.record('run-b.0', { input_tokens: 7, output_tokens: 1 });

  assert.deepEqual(ledgerMod.ledger.get('run-a.0'), {
    inputTokens: 150, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2,
  });
  assert.equal(ledgerMod.ledger.get('run-b.0')?.inputTokens, 7);
});

test('a resumed run gets a fresh bucket, so persisted tokens are never counted twice', () => {
  // The attempt number is part of the key precisely because a gateway can
  // outlive the run that started it.
  ledgerMod.ledger.clear();
  ledgerMod.record('run-a.0', { input_tokens: 100, output_tokens: 10 });
  ledgerMod.record('run-a.1', { input_tokens: 30, output_tokens: 3 });
  assert.equal(ledgerMod.ledger.get('run-a.0')?.inputTokens, 100);
  assert.equal(ledgerMod.ledger.get('run-a.1')?.inputTokens, 30);
});

test('OpenAI-shaped usage counts the same as Anthropic-shaped', () => {
  // Both reach the ledger depending on mode and on where in the translation
  // the response was observed.
  ledgerMod.ledger.clear();
  ledgerMod.record('k', { prompt_tokens: 200, completion_tokens: 20 });
  assert.equal(ledgerMod.ledger.get('k')?.inputTokens, 200);
  assert.equal(ledgerMod.ledger.get('k')?.outputTokens, 20);
});

test('nonsense in a usage object is ignored rather than poisoning a total', () => {
  ledgerMod.ledger.clear();
  ledgerMod.record('k', { input_tokens: 'lots', output_tokens: -5, cache_read_input_tokens: NaN });
  assert.deepEqual(ledgerMod.ledger.get('k'), {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1,
  });
});

// ---- request dumps --------------------------------------------------------

const dumps = ledgerMod as unknown as {
  makeDumper(dir: string, log?: (line: string) => void): null | {
    dir: string;
    begin(key: string | null, req: { url?: string; headers?: Record<string, unknown> }, raw: Buffer):
      (info: Record<string, unknown>) => void;
  };
  replay(req: { headers: unknown; method: string; url: string }, raw: Buffer): NodeJS.ReadableStream & {
    headers: unknown; method: string; url: string;
  };
  tee(res: Record<string, unknown>, key: string | null, observe?: (info: Record<string, unknown>) => void): void;
};

const scratch = () => mkdtempSync(join(tmpdir(), 'foreman-dump-'));

const fakeReq = (headers: Record<string, string>, url = '/v1/messages?beta=true') => (
  { headers, method: 'POST', url }
);

test('dumping is a no-op when the directory is unset', () => {
  // Off by default is the whole point: these files hold prompts and repository
  // contents, and no one should find them on disk without having asked.
  assert.equal(dumps.makeDumper(''), null);
  assert.equal(dumps.makeDumper(undefined as unknown as string), null);
});

test('a request is written with its secrets redacted and its shape summarised', () => {
  const dir = join(scratch(), 'nested', 'not-yet-made');
  const lines: string[] = [];
  const d = dumps.makeDumper(dir, (l) => lines.push(l))!;
  const body = {
    model: 'kimi-k3:cloud', stream: true, max_tokens: 8,
    system: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }],
    tools: [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
  };
  const raw = Buffer.from(JSON.stringify(body));
  const finish = d.begin('run-a.0', fakeReq({
    'x-api-key': 'sk-secret', authorization: 'Bearer also-secret', 'content-type': 'application/json',
  }), raw);

  assert.ok(existsSync(dir), 'the dump dir is created on first use');
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 1);
  assert.match(files[0], /-run-a\.0-1\.json$/);
  const got = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(got.key, 'run-a.0');
  assert.equal(got.url, '/v1/messages?beta=true');
  assert.equal(got.headers['x-api-key'], '[redacted]');
  assert.equal(got.headers.authorization, '[redacted]');
  assert.equal(got.headers['content-type'], 'application/json');
  assert.deepEqual(got.body, body);
  assert.deepEqual(got.summary, {
    model: 'kimi-k3:cloud', stream: true, systemChars: 5, toolCount: 3, messageCount: 2,
    bodyBytes: raw.length,
  });
  assert.deepEqual(lines, ['[dump] run-a.0 -> kimi-k3:cloud tools=3 system=5 stream=true']);

  finish({ status: 200, durationMs: 1234, bytes: 99, sawUsage: true, firstByteMs: 12 });
  const after = readdirSync(dir).sort();
  assert.deepEqual(after, [files[0], files[0].replace(/\.json$/, '.response.json')]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, after[1]), 'utf8')), {
    status: 200, durationMs: 1234, bytes: 99, sawUsage: true, firstByteMs: 12,
  });
  assert.equal(lines[1], '[dump] run-a.0 <- 200 in 1234ms 99B usage=true');
});

test('a malformed body is still dumped, as the raw string, and still reaches the handler', async () => {
  // The bad body may be the very thing being diagnosed, so it is kept
  // verbatim; and the dump must not be what turns it into a failure.
  const dir = scratch();
  const d = dumps.makeDumper(dir, () => {})!;
  const raw = Buffer.from('{"model": "x", not json');
  const req = fakeReq({ 'x-api-key': 'k' });
  d.begin(null, req, raw);
  const [file] = readdirSync(dir);
  assert.match(file, /-unkeyed-1\.json$/);
  const got = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  assert.equal(got.body, '{"model": "x", not json');
  assert.equal(got.summary.model, null);
  assert.equal(got.summary.bodyBytes, raw.length);

  // What the handler would then read: the same bytes, under the same identity.
  const r = dumps.replay(req, raw);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/v1/messages?beta=true');
  assert.equal(r.headers, req.headers);
  const chunks: Buffer[] = [];
  for await (const c of r as AsyncIterable<Buffer>) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(), raw.toString());
});

test('an unwritable dump dir does not fail the request', () => {
  // A file where a directory should be: mkdir -p cannot succeed.
  const blocker = join(scratch(), 'file');
  require_('node:fs').writeFileSync(blocker, '');
  const d = dumps.makeDumper(join(blocker, 'sub'), () => {})!;
  const finish = d.begin('k', fakeReq({}), Buffer.from('{}'));
  assert.equal(typeof finish, 'function');
  assert.doesNotThrow(() => finish({ status: 200 }));
});

test('the tee reports the response outcome once, and still passes every byte through', () => {
  const written: unknown[] = [];
  const res = {
    statusCode: 200,
    write(chunk: unknown) { written.push(chunk); return true; },
    end(chunk?: unknown) { if (chunk !== undefined) written.push(chunk); return this; },
  };
  const seen: Record<string, unknown>[] = [];
  ledgerMod.ledger.clear();
  dumps.tee(res as unknown as Record<string, unknown>, 'run-t.0', (info) => seen.push(info));
  res.write('data: {"type":"message_start"}\n\n');
  res.write(Buffer.from('data: {"type":"message_delta","usage":{"input_tokens":3,"output_tokens":1}}\n\n'));
  res.end('data: [DONE]\n');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 200);
  assert.equal(seen[0].sawUsage, true);
  assert.equal(seen[0].bytes, written.reduce<number>((a, c) => a + Buffer.byteLength(c as string), 0));
  assert.equal(typeof seen[0].durationMs, 'number');
  assert.equal(typeof seen[0].firstByteMs, 'number');
  assert.equal(written.length, 3, 'nothing is swallowed or duplicated');
  assert.equal(ledgerMod.ledger.get('run-t.0')?.inputTokens, 3, 'counting still happens alongside');
});

test('an observer that throws cannot break the response', () => {
  let ended = false;
  const res = { statusCode: 200, write() { return true; }, end() { ended = true; return this; } };
  dumps.tee(res as unknown as Record<string, unknown>, null, () => { throw new Error('boom'); });
  assert.doesNotThrow(() => res.end());
  assert.ok(ended);
});
