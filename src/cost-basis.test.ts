/**
 * The cost basis, and the boolean it replaced.
 *
 * These are the rules that decide whether a dollar cap may kill a run and
 * whether someone is told they are spending nothing. Both have been wrong in
 * production before — a real mission was interrupted at "125% of budget" over
 * Anthropic prices applied to Ollama tokens — so they are pinned here rather
 * than left to the call sites that read them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { combineBasis, costBasisOf, isPriced } from './types.js';

test('a recorded basis is returned as written', () => {
  assert.equal(costBasisOf({ costBasis: 'free' }), 'free');
  assert.equal(costBasisOf({ costBasis: 'unpriced' }), 'unpriced');
  assert.equal(costBasisOf({ costBasis: 'priced' }), 'priced');
});

test('a run recorded before the split still answers, and errs toward spend', () => {
  // `metered: false` meant "not priceable", which covered both free and
  // unpriced. It cannot be split after the fact, so it reads as unpriced:
  // telling someone a paid run was free is the error that costs money.
  assert.equal(costBasisOf({ metered: false }), 'unpriced');
  assert.equal(costBasisOf({ metered: true }), 'priced');
  // Neither field: the old default was metered, and every run recorded that
  // way was a Claude Code one.
  assert.equal(costBasisOf({}), 'priced');
});

test('costBasis wins over a stale metered boolean', () => {
  // Both are written together, but a record round-tripped through older code
  // could disagree. The richer field is the one that means something.
  assert.equal(costBasisOf({ costBasis: 'free', metered: true }), 'free');
  assert.equal(costBasisOf({ costBasis: 'priced', metered: false }), 'priced');
});

test('only a priced run may show or enforce dollars', () => {
  assert.equal(isPriced({ costBasis: 'priced' }), true);
  assert.equal(isPriced({ costBasis: 'free' }), false);
  assert.equal(isPriced({ costBasis: 'unpriced' }), false);
});

test('free and unpriced are distinct, which is the whole point', () => {
  // The regression this file exists to prevent: a local model and an OpenAI
  // key collapsing to one state and rendering identically.
  assert.notEqual(costBasisOf({ costBasis: 'free' }), costBasisOf({ costBasis: 'unpriced' }));
  // ...while still agreeing about the only thing enforcement asks them.
  assert.equal(isPriced({ costBasis: 'free' }), isPriced({ costBasis: 'unpriced' }));
});

test('a mixed run is priced if any role bills real dollars', () => {
  // A Claude director delegating to local workers still spends real money on
  // its own turns; leaving that uncapped is worse than overstating it.
  assert.equal(combineBasis('priced', 'free'), 'priced');
  assert.equal(combineBasis('free', 'priced'), 'priced');
  assert.equal(combineBasis('priced', 'unpriced'), 'priced');
});

test('a mixed run is never called free when part of it is not', () => {
  assert.equal(combineBasis('free', 'unpriced'), 'unpriced');
  assert.equal(combineBasis('unpriced', 'free'), 'unpriced');
});

test('only two free roles make a free run', () => {
  assert.equal(combineBasis('free', 'free'), 'free');
});

test('combining is order-independent', () => {
  const all = ['priced', 'free', 'unpriced'] as const;
  for (const a of all) {
    for (const b of all) {
      assert.equal(combineBasis(a, b), combineBasis(b, a), `${a}+${b} must not depend on role order`);
    }
  }
});
