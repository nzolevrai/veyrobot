import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logBotError } from '../dist/error-log.js';

test('bot error logger emits sanitized structured details rather than raw exception fields', () => {
  const canaries = ['client_secret=BOT_CS_91', 'SESSION_KEY=BOT_SK_82', 'Bearer BOT_BEARER_73', 'Cookie: sid=BOT_COOKIE_64', 'postgresql://BOT_USER:BOT_PASS@db/app', 'BOT_NESTED_55'];
  const error = Object.assign(new Error(`${canaries.join(' ')}\nSESSION_KEY=${canaries[5]} forged log line`), {
    name: canaries[0],
    code: canaries[1],
    cause: Object.assign(new Error(`SESSION_KEY=${canaries[5]}`), { name: 'Error' }),
  });
  let emitted = '';
  const original = console.error;
  console.error = value => { emitted = String(value); };
  try { logBotError('worker_failed', 'worker', 'Discord action failed', error); }
  finally { console.error = original; }
  const record = JSON.parse(emitted);
  for (const canary of canaries) assert.equal(emitted.includes(canary), false, `bot logger leaked ${canary}`);
  assert.equal(record.event, 'worker_failed');
  assert.equal(record.message, 'Discord action failed');
  assert.equal(record.exception.name, 'Error');
  assert.equal(record.exception.cause.name, 'Error');
  assert.equal(emitted.includes('forged log line'), true, 'line breaks are normalized into a single safe message');
  assert.equal(emitted.split('\n').length, 1);
});
