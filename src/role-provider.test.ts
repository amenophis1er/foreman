import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRole } from './role-provider.js';

const models = [
  { id: 'fable' }, { id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' },
  { id: 'gemma4:12b', providerId: 'ollama-local' },
  { id: 'gpt-5.5', providerId: 'codex-local' },
  { id: 'kimi-k3', providerId: 'prov-abc' },
];

test('reconcileRole: a consistent pairing passes through untouched', () => {
  assert.deepEqual(reconcileRole('director', 'fable', undefined, models), { providerId: undefined });
  assert.deepEqual(reconcileRole('workers', 'gpt-5.5', 'codex-local', models), { providerId: 'codex-local' });
  assert.deepEqual(reconcileRole('workers', 'gemma4:12b', 'ollama-local', models), { providerId: 'ollama-local' });
});

test('reconcileRole: an Anthropic alias on the Codex provider is corrected — the bug this exists for', () => {
  const r = reconcileRole('director', 'fable', 'codex-local', models);
  assert.equal(r.providerId, undefined);
  assert.match(r.note ?? '', /fable is served by the project's provider, not codex-local/);
});

test('reconcileRole: a listed model moves to whichever provider lists it', () => {
  assert.equal(reconcileRole('workers', 'gemma4:12b', undefined, models).providerId, 'ollama-local');
  assert.equal(reconcileRole('workers', 'gpt-5.5', 'ollama-local', models).providerId, 'codex-local');
  assert.equal(reconcileRole('director', 'kimi-k3', 'codex-local', models).providerId, 'prov-abc');
  assert.equal(reconcileRole('director', 'FABLE', 'codex-local', models).providerId, undefined);
});

test('reconcileRole: a provider pin without a model is stale and dropped', () => {
  const r = reconcileRole('director', undefined, 'codex-local', models);
  assert.equal(r.providerId, undefined);
  assert.match(r.note ?? '', /no model was chosen/);
  assert.deepEqual(reconcileRole('director', undefined, undefined, models), { providerId: undefined });
  assert.deepEqual(reconcileRole('director', '', '  ', models), { providerId: undefined });
});

test('reconcileRole: an unlisted model keeps its provider, unless it is a Claude id on a closed provider', () => {
  // A custom endpoint's model the discovery call missed: trust the pairing.
  assert.deepEqual(reconcileRole('workers', 'mystery-9b', 'prov-abc', models), { providerId: 'prov-abc' });
  assert.deepEqual(reconcileRole('workers', 'mystery-9b', undefined, models), { providerId: undefined });
  // A full claude-* id nobody listed still cannot go through Codex or Ollama.
  const r = reconcileRole('director', 'claude-opus-4-1', 'codex-local', models);
  assert.equal(r.providerId, undefined);
  assert.match(r.note ?? '', /Anthropic model/);
  assert.equal(reconcileRole('director', 'claude-opus-4-1', 'ollama-local', models).providerId, undefined);
  // On a custom endpoint a claude-* id may be a real proxy route; left alone.
  assert.equal(reconcileRole('director', 'claude-opus-4-1', 'prov-abc', models).providerId, 'prov-abc');
});

test('reconcileRole: works with an empty model list (discovery failed) by the closed-provider rule alone', () => {
  assert.equal(reconcileRole('director', 'fable', 'codex-local', []).providerId, undefined);
  assert.equal(reconcileRole('director', 'gpt-5.5', 'codex-local', []).providerId, 'codex-local');
});
