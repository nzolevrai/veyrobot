import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Redis publication failure uses bounded exponential backoff and stops the pass', async () => {
  const { createDispatcher } = await import('../dist/dispatcher.js');
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  let addCalls = 0;
  let sqlReads = 0;
  const errors = [];
  const queue = {
    getBackend: () => ({ client: Promise.resolve({ status: 'ready' }) }),
    add: async () => { addCalls++; throw new Error('OOM command not allowed'); },
  };
  const prisma = {
    $queryRaw: async () => { sqlReads++; return [{ operationId: 'requested-case-00000001', guildId: '123456789012345678', action: 'KICK' }]; },
    moderationCase: { findMany: async () => [{ id: 'expiry-case', guildId: '123456789012345678' }] },
  };
  const dispatch = createDispatcher(prisma, queue, () => true, (key, message, error) => errors.push({ key, message, error }));
  try {
    await Promise.resolve();
    await dispatch();
    assert.equal(addCalls, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, 'moderation-queue-dispatch');
    assert.match(errors[0].message, /PostgreSQL request remains durable/);
    assert.equal(sqlReads, 1);
    for (let i = 0; i < 10; i++) await dispatch();
    assert.equal(addCalls, 1, 'repeated dispatcher wakes during cooldown must not republish');
    assert.equal(sqlReads, 1, 'cooldown must avoid repeated PostgreSQL scans');
    assert.equal(errors.length, 1, 'one failed pass emits one bounded diagnostic');
    now += 1_000;
    await dispatch();
    assert.equal(addCalls, 2, 'first retry occurs after the initial one-second backoff');
    assert.equal(errors.length, 2);
    now += 1_999;
    await dispatch();
    assert.equal(addCalls, 2, 'next retry is delayed by the doubled backoff');
  } finally {
    Date.now = realNow;
  }
});
