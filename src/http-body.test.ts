import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_BODY_LIMIT, BodyError, DEFAULT_BODY_LIMIT, bodyLimitFor, parseBody,
} from './http-body.js';

test('bodyLimitFor: only POST /attachments gets the large cap', () => {
  assert.equal(bodyLimitFor('POST', '/attachments'), ATTACHMENT_BODY_LIMIT);
  assert.equal(bodyLimitFor('post', '/attachments'), ATTACHMENT_BODY_LIMIT);
  assert.equal(bodyLimitFor('GET', '/attachments'), DEFAULT_BODY_LIMIT);
  assert.equal(bodyLimitFor('POST', '/mkdir'), DEFAULT_BODY_LIMIT);
  assert.equal(bodyLimitFor('POST', '/attachments/extra'), DEFAULT_BODY_LIMIT);
  assert.equal(bodyLimitFor(undefined, '/runs'), DEFAULT_BODY_LIMIT);
});

test('parseBody: an empty body is an empty object', () => {
  assert.deepEqual(parseBody(''), {});
  assert.deepEqual(parseBody('   '), {});
  assert.deepEqual(parseBody(Buffer.alloc(0)), {});
});

test('parseBody: an object comes back as itself', () => {
  assert.deepEqual(parseBody('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
  assert.deepEqual(parseBody(Buffer.from('{"nested":{"k":true}}')), { nested: { k: true } });
});

test('parseBody: JSON that is not an object has no fields to read', () => {
  assert.deepEqual(parseBody('[1,2,3]'), {});
  assert.deepEqual(parseBody('42'), {});
  assert.deepEqual(parseBody('null'), {});
  assert.deepEqual(parseBody('"hello"'), {});
});

test('parseBody: junk is the client’s fault, not a 500', () => {
  assert.throws(() => parseBody('{bad'), (err: unknown) => {
    assert.ok(err instanceof BodyError);
    assert.equal(err.status, 400);
    assert.equal(err.message, 'invalid JSON body');
    return true;
  });
  assert.throws(() => parseBody('{"a":}'), BodyError);
});
