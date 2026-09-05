/**
 * The one price table Foreman keeps, and the rules that keep it honest:
 * exact provenance, per-token units, and "unknown means unpriced" — never a
 * near-enough guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_PRICES_VERIFIED, isOpenAiHost, openaiPrice, openaiPriceNote,
} from './openai-prices.js';
import { priceUsage } from './prices.js';

test('list prices are stored per token, straight from the per-million figures', () => {
  // gpt-5: $1.25 in, $0.125 cached, $10.00 out per 1M on the verified page.
  const p = openaiPrice('gpt-5')!;
  assert.equal(p.input, 1.25 / 1_000_000);
  assert.equal(p.cacheRead, 0.125 / 1_000_000);
  assert.equal(p.output, 10 / 1_000_000);
  // One million input tokens costs exactly the list price.
  assert.ok(Math.abs(priceUsage(p, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) - 1.25) < 1e-9);
});

test('a dated snapshot resolves to its family by longest prefix, never to a sibling', () => {
  assert.deepEqual(openaiPrice('gpt-5.4-2026-03-01'), openaiPrice('gpt-5.4'));
  // The longer family wins: a mini snapshot is priced as mini, not as 5.4.
  assert.deepEqual(openaiPrice('gpt-5.4-mini-2026-03-01'), openaiPrice('gpt-5.4-mini'));
  assert.notDeepEqual(openaiPrice('gpt-5.4-mini'), openaiPrice('gpt-5.4'));
  // Case and whitespace are not reasons to refuse.
  assert.deepEqual(openaiPrice('  GPT-5-Nano '), openaiPrice('gpt-5-nano'));
});

test('a model the table does not know is unpriced — not the nearest neighbour', () => {
  assert.equal(openaiPrice('gpt-7'), null);
  assert.equal(openaiPrice('gpt-5.4x'), null, 'a prefix without the dash is a different name');
  assert.equal(openaiPrice(''), null);
  assert.equal(openaiPrice(undefined), null);
});

test('pro models list no cached-input rate, and the field is absent rather than zero', () => {
  const p = openaiPrice('gpt-5.5-pro')!;
  assert.equal('cacheRead' in p, false, 'absent means "same as input" to priceUsage; zero would mean free');
});

test('only api.openai.com is priced from this table', () => {
  assert.equal(isOpenAiHost('https://api.openai.com'), true);
  assert.equal(isOpenAiHost('https://api.openai.com/v1'), true);
  assert.equal(isOpenAiHost('https://openrouter.ai/api'), false, 'a reseller publishes its own rates');
  assert.equal(isOpenAiHost('http://127.0.0.1:11434'), false);
  assert.equal(isOpenAiHost('not a url'), false);
  assert.equal(isOpenAiHost(undefined), false);
});

test('the picker note names the source and the day it was checked', () => {
  const note = openaiPriceNote('gpt-5.4')!;
  assert.match(note, /^\$2\.50 in \/ \$15\.00 out per million tokens/);
  assert.match(note, new RegExp(`verified ${OPENAI_PRICES_VERIFIED}$`));
  assert.equal(openaiPriceNote('gpt-7'), null);
});
