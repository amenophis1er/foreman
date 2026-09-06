import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStop } from './errors.js';

// The payload says the limit lifts 16935 s after it was issued; pin "now" to that.
const now = 1788692024 * 1000 - 16935 * 1000;

test('a Codex usage limit becomes one sentence with the reset time', () => {
  const raw = 'API Error: Request rejected (429) · codex upstream 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1788692024,"eligible_promo":null,"resets_in_seconds":16935}}';
  const r = describeStop(raw, now)!;
  assert.equal(r.kind, 'usage-limit');
  assert.equal(r.resetsAt, 1788692024000);
  assert.match(r.text, /^Codex usage limit reached on the plus plan — resets at .* \(in 4h 4\dm\)\.$/);
  assert.doesNotMatch(r.text, /[{}]/);
});

test('rate limits, auth and server errors are classified; unknown text is clipped to its first line', () => {
  assert.equal(describeStop('anthropic: 429 Too Many Requests, retry_after 30', now)!.kind, 'rate-limit');
  assert.equal(describeStop('401 Unauthorized: invalid x-api-key', now)!.kind, 'auth');
  assert.equal(describeStop('fetch failed: ECONNREFUSED 127.0.0.1:11434 (ollama)', now)!.kind, 'server');
  const other = describeStop('API Error: something odd\nsecond line', now)!;
  assert.equal(other.kind, 'other');
  assert.equal(other.text, 'something odd');
  assert.equal(describeStop('', now), null);
});
