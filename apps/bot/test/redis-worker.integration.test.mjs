import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && process.env.RUN_REDIS_INTEGRATION === '1';

test('durable PostgreSQL admission dispatches through real BullMQ and production worker to controlled Discord adapter', { skip: !enabled }, async () => {
  const [{ prisma, rejectPendingAfterDisable }, moderation, { Queue }, { createDispatcher }, { createModerationWorker }] = await Promise.all([
    import('@veyrobot/db'), import('@veyrobot/moderation'), import('bullmq'), import('../dist/dispatcher.js'), import('../dist/worker.js'),
  ]);
  const operationId = `redis_worker_${randomUUID()}`;
  const guildId = `8${randomUUID().replace(/\D/g, '').padEnd(17, '0').slice(0, 17)}`;
  const actorId = '123456789012345679';
  const targetId = '123456789012345680';
  const queueName = `veyrobot-test-${randomUUID()}`;
  const redis = moderation.redisConnection(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const queue = new Queue(queueName, { connection: redis });
  let kicks = 0;
  const high = { comparePositionTo: () => 1 };
  const actor = { id: actorId, permissions: { bitfield: 2n }, roles: { highest: high } };
  const bot = { permissions: { bitfield: 2n }, roles: { highest: high } };
  const target = { id: targetId, roles: { highest: high }, kick: async () => { kicks++; } };
  const guild = { id: guildId, ownerId: '123456789012345681', members: { fetch: async ({ user }) => user === actorId ? actor : target, fetchMe: async () => bot } };
  const client = { isReady: () => true, guilds: { cache: new Map([[guildId, guild]]) } };
  const worker = createModerationWorker(client, redis, prisma, moderation, rejectPendingAfterDisable, () => undefined, undefined, queueName);
  try {
    await queue.waitUntilReady();
    await prisma.guildConfig.create({ data: { guildId, updatedBy: actorId, memberActionsEnabled: true } });
    await prisma.moderationCase.create({ data: { operationId, guildId, actorId, targetId, action: 'KICK', reason: 'Redis integration controlled action', status: 'requested' } });
    const dispatch = createDispatcher(prisma, queue, () => true, (key, _message, error) => { throw new Error(`${key}: ${error instanceof Error ? error.name : 'unknown'}`); });
    await new Promise(resolve => setTimeout(resolve, 50));
    await dispatch();
    const deadline = Date.now() + 10_000;
    let row;
    while (Date.now() < deadline) {
      row = await prisma.moderationCase.findUnique({ where: { operationId } });
      if (row?.status === 'succeeded' || row?.status === 'failed' || row?.status === 'uncertain') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(row?.status, 'succeeded');
    assert.equal(kicks, 1, 'production executor should call the controlled Discord adapter exactly once');
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await prisma.moderationCase.deleteMany({ where: { operationId } });
    await prisma.guildConfig.deleteMany({ where: { guildId } });
    await prisma.$disconnect();
  }
});
