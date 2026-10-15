import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireSingleBotLease } from '../dist/single-instance.js';

test('a second bot is refused until the first releases its database lock', { skip: process.env.RUN_POSTGRES_INTEGRATION !== '1' }, async () => {
  const first = await acquireSingleBotLease(process.env.DATABASE_URL, () => { throw new Error('unexpected lease loss'); });
  try {
    await assert.rejects(acquireSingleBotLease(process.env.DATABASE_URL, () => undefined), /autre processus bot/);
  } finally { await first(); }
  const next = await acquireSingleBotLease(process.env.DATABASE_URL, () => { throw new Error('unexpected lease loss'); });
  await next();
});
