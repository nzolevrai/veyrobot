import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizedErrorDetails } from '../dist/error-details.js';

test('server exception details are useful but redact common credentials and bound output', () => {
  const details = sanitizedErrorDetails(Object.assign(new Error('Bearer abc.def.ghi cookie=session=secret password=hunter2 postgresql://user:secret@db/app'), { code: 'P1001' }));
  assert.equal(details.code, 'P1001');
  assert.match(details.message, /Bearer \[redacted\]/);
  assert.doesNotMatch(details.message, /secret|hunter2|abc\.def\.ghi/);
  const caused = sanitizedErrorDetails(new Error('request failed', { cause: new Error('client_secret=hidden') }));
  assert.equal(caused.cause?.message, 'client_secret=[redacted]');
  assert.equal(sanitizedErrorDetails(new Error('x'.repeat(1000))).message.length, 500);
});
