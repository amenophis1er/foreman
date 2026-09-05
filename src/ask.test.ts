/**
 * Asking a human — the mechanics every ask surface shares.
 *
 * What is pinned here is not the picker; it is the contract between a model
 * that asked in structured form and the prose it gets back, plus the one rule
 * with no exceptions: every ask carries an unattended default, and `0` means
 * "never", not "immediately".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { armAskTimeout, formatAnswers, normaliseQuestions } from './ask.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('answers are echoed question by question, in the order asked', () => {
  const qs = normaliseQuestions([
    { question: 'Stack?', options: ['plain HTML', 'React'] },
    { question: 'Imagery?', options: ['stock photos', 'you provide assets'] },
  ]);
  const out = formatAnswers(qs, { 'Stack?': 'plain HTML', 'Imagery?': 'stock photos' });
  assert.equal(out, '• Stack?\n  → plain HTML\n• Imagery?\n  → stock photos');
});

test('an unanswered question is said to be unanswered, never silently dropped', () => {
  // Silence must not read as agreement with the recommended option; the
  // model is told to decide, which is the same instruction the timeout gives.
  const qs = normaliseQuestions([{ question: 'Scope?', options: ['one page', 'multi-page'] }]);
  assert.match(formatAnswers(qs, {}), /no answer — decide yourself/);
  assert.match(formatAnswers(qs, { 'Scope?': '   ' }), /no answer — decide yourself/);
});

test('options may be strings or {label, hint}, and are trimmed', () => {
  const [q] = normaliseQuestions([{
    question: '  Stack?  ',
    options: [' plain HTML ', { label: 'React', hint: 'needs a build step' }, { label: '  ' }, 42],
    multi: true,
  }]);
  assert.equal(q.question, 'Stack?');
  // A string option carries no hint key at all — not `hint: undefined` —
  // so the JSON the picker receives is exactly as small as what was sent.
  assert.deepEqual(q.options, [
    { label: 'plain HTML' },
    { label: 'React', hint: 'needs a build step' },
  ]);
  assert.equal(q.multi, true);
});

test('at most three questions and six options each, and a blank question is dropped', () => {
  const qs = normaliseQuestions([
    { question: 'a', options: ['1', '2', '3', '4', '5', '6', '7', '8'] },
    { question: '', options: ['x'] },
    { question: 'b', options: ['1'] },
    { question: 'c', options: ['1'] },
    { question: 'd', options: ['1'] },
  ]);
  // 'a', (blank dropped), 'b', 'c' — the fourth real question is past the cap
  // because the cap applies to what the model sent, not to what survived.
  assert.deepEqual(qs.map((q) => q.question), ['a', 'b']);
  assert.equal(qs[0].options.length, 6);
});

test('non-array input yields no questions rather than throwing', () => {
  assert.deepEqual(normaliseQuestions(undefined), []);
  assert.deepEqual(normaliseQuestions('Stack?'), []);
  assert.deepEqual(normaliseQuestions({ question: 'Stack?' }), []);
});

test('the ask timer fires once, cancel prevents it, and zero never arms', async () => {
  let fired = 0;
  armAskTimeout(15, () => fired++);
  await sleep(60);
  assert.equal(fired, 1);

  const b = armAskTimeout(15, () => fired++);
  b.cancel();
  await sleep(40);
  assert.equal(fired, 1, 'a cancelled ask must not fire');

  const c = armAskTimeout(0, () => fired++);
  await sleep(30);
  assert.equal(fired, 1, '0 means never, not immediately');
  c.cancel(); // must be safe on a timer that was never armed

  armAskTimeout(NaN, () => fired++);
  armAskTimeout(-5, () => fired++);
  await sleep(30);
  assert.equal(fired, 1, 'nonsense durations never arm either');
});
