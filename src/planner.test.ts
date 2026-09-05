/**
 * The planner's proposal safety nets.
 *
 * Two small pure rules sit between what the planner writes and what the card
 * shows. Both exist because of one afternoon: a proposal whose criteria said
 * "screenshots saved" arrived with the browser off, and a planner that could
 * not see the machine's model list could not have recommended one. Neither
 * rule is allowed to depend on the model remembering something.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { needsBrowser, pickKnownModel, type PlannerModel } from './planner.js';

test('criteria that need a browser are recognised from the words the planner wrote', () => {
  // The exact shapes from the real proposal that shipped with the browser off.
  assert.equal(needsBrowser('Build a static site.', [
    'index.html opens correctly in a browser with no console errors',
  ]), true);
  assert.equal(needsBrowser('Build a static site.', [
    'A screenshots/ directory exists containing desktop-full.png',
  ]), true);
  assert.equal(needsBrowser('Build a static site.', [
    'All images load successfully (no broken image icons) when checked in a real browser',
  ]), true);
  assert.equal(needsBrowser('Verify the page renders correctly at 375px mobile width.', []), true);
  assert.equal(needsBrowser('Use Playwright to click through the checkout.', []), true);
});

test('a mission with no browser in it is left alone', () => {
  // A false positive costs a switch the human can flip off; a false negative
  // cost an hour. The net is broad, but it must not fire on everything.
  assert.equal(needsBrowser('Refactor the payment module and add unit tests.', [
    'npm test passes', 'no function longer than 40 lines',
  ]), false);
  assert.equal(needsBrowser('Write a CLI that converts CSV to JSON.', ['handles empty files']), false);
  assert.equal(needsBrowser('', []), false);
});

const MODELS: PlannerModel[] = [
  { id: 'sonnet', label: 'Sonnet', providerLabel: 'Anthropic', costBasis: 'priced' },
  { id: 'glm-5.3-flash:cloud', label: 'glm-5.3-flash:cloud', providerId: 'ollama-local', providerLabel: 'Ollama', costBasis: 'unpriced' },
  { id: 'qwen3.8:27b-q8_0', label: 'qwen3.8:27b-q8_0', providerId: 'ollama-local', providerLabel: 'Ollama', costBasis: 'free' },
];

test('a recommended model is kept only if the machine lists it', () => {
  assert.equal(pickKnownModel('sonnet', MODELS)?.id, 'sonnet');
  assert.equal(pickKnownModel('glm-5.3-flash:cloud', MODELS)?.providerId, 'ollama-local');
  // Case and whitespace are not reasons to refuse a real id.
  assert.equal(pickKnownModel('  Sonnet ', MODELS)?.id, 'sonnet');
  assert.equal(pickKnownModel('GLM-5.3-FLASH:CLOUD', MODELS)?.id, 'glm-5.3-flash:cloud');
});

test('an id the machine cannot run becomes inherit, never a mission that fails at dispatch', () => {
  assert.equal(pickKnownModel('gpt-9-ultra', MODELS), undefined);
  assert.equal(pickKnownModel('claude-opus-5', MODELS), undefined); // real elsewhere, not listed here
  assert.equal(pickKnownModel(undefined, MODELS), undefined);
  assert.equal(pickKnownModel('', MODELS), undefined);
  assert.equal(pickKnownModel('sonnet', []), undefined);
  assert.equal(pickKnownModel('sonnet', undefined), undefined);
});
