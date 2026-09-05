/**
 * Prices, and where they are allowed to come from.
 *
 * The rule these defend is not arithmetic, it is provenance: a dollar figure
 * on a gateway run may only ever come from the endpoint that sends the bill.
 * Foreman showed a fabricated figure once — Anthropic's rates on Ollama
 * tokens — and interrupted a finished mission at "125% of budget" over it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePricing, priceUsage } from './prices.js';

const usage = (over: Partial<Record<string, number>> = {}) => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over,
});

test('an OpenRouter pricing object parses, cache rates included', () => {
  // The exact shape the live endpoint returns: rates as strings, per token.
  assert.deepEqual(parsePricing({
    prompt: '0.000002', completion: '0.00001',
    input_cache_read: '0.0000002', input_cache_write: '0.0000025',
    web_search: '0.01',
  }), { input: 0.000002, output: 0.00001, cacheRead: 0.0000002, cacheWrite: 0.0000025 });
});

test('a model published at zero is priced at zero, not treated as unpriced', () => {
  // OpenRouter's `:free` variants. Zero is a real answer from the biller.
  assert.deepEqual(parsePricing({ prompt: '0', completion: '0' }), { input: 0, output: 0 });
});

test('a half-published price is no price at all', () => {
  // A figure missing its output rate is confidently too low, and a number
  // that is wrong is worse than none: "unpriced" sends someone to their
  // vendor dashboard, a wrong total tells them not to bother.
  assert.equal(parsePricing({ prompt: '0.000002' }), null);
  assert.equal(parsePricing({ completion: '0.00001' }), null);
  assert.equal(parsePricing({}), null);
  assert.equal(parsePricing(null), null);
  assert.equal(parsePricing('cheap'), null);
});

test('unparseable or negative rates are unpublished, never zero', () => {
  // Reading a bad rate as 0 would price a paid model at nothing — the exact
  // class of silent, confident understatement this module exists to avoid.
  assert.equal(parsePricing({ prompt: 'free', completion: '0.1' }), null);
  assert.equal(parsePricing({ prompt: '-1', completion: '0.1' }), null);
  assert.equal(parsePricing({ prompt: NaN, completion: 1 }), null);
});

test('cost is the sum of each token class at its own rate', () => {
  const price = { input: 0.000002, output: 0.00001, cacheRead: 0.0000002, cacheWrite: 0.0000025 };
  const cost = priceUsage(price, usage({
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2000,
  }));
  // 0.002 + 0.005 + 0.002 + 0.005
  assert.ok(Math.abs(cost - 0.014) < 1e-9, `got ${cost}`);
});

test('unpublished cache rates fall back to the input rate', () => {
  const price = { input: 0.000002, output: 0.00001 };
  assert.equal(
    priceUsage(price, usage({ cacheReadTokens: 1000 })),
    priceUsage(price, usage({ inputTokens: 1000 })),
  );
});

test('no tokens, no cost', () => {
  assert.equal(priceUsage({ input: 1, output: 1 }, usage()), 0);
});
