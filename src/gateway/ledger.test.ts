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
