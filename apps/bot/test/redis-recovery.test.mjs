import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '@veyrobot/db';
import { createDispatcher } from '../dist/dispatcher.js';

test('a disconnected producer leaves a durable request; reconnect republishes it', { skip: process.env.RUN_POSTGRES_INTEGRATION !== '1' }, async () => {
  const operationId = `recovery_${randomUUID()}`;
  const guildId = `8${randomUUID().replace(/\D/g, '').padEnd(17, '0').slice(0, 17)}`;
  const client = { status: 'connecting' };
  const published = [];
  const queue = { getBackend: () => ({ client: Promise.resolve(client) }), add: async (_name, data) => { published.push(data); } };
  try {
    await prisma.moderationCase.create({ data: { operationId, guildId, actorId: '123456789012345679', targetId: '123456789012345680', action: 'KICK', reason: 'recovery test', status: 'requested' } });
    const dispatch = createDispatcher(prisma, queue, () => true, () => undefined);
    await new Promise(resolve => setImmediate(resolve));
    await dispatch();
    assert.equal(published.length, 0);
    assert.equal((await prisma.moderationCase.findUnique({ where: { operationId } })).status, 'requested');
    client.status = 'ready';
    await dispatch();
    assert.ok(published.some(job => job.operationId === operationId));
    assert.equal((await prisma.moderationCase.findUnique({ where: { operationId } })).status, 'requested');
  } finally {
    await prisma.moderationCase.deleteMany({ where: { operationId } });
    await prisma.$disconnect();
  }
});
