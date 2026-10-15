import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { prisma } from '@veyrobot/db';
import { redisConnection } from '@veyrobot/moderation';
import { createDispatcher } from '../dist/dispatcher.js';

if (!process.env.DATABASE_URL?.includes('veyrobot_arch_bench')) throw new Error('Use isolated veyrobot_arch_bench database.');
const port = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
const name = `veyrobot-fault-${randomUUID().slice(0, 12)}`;
const queueName = `veyrobot-fault-${randomUUID().slice(0, 12)}`;
const operationId = `fault_${randomUUID()}`;
const guildId = `7${randomUUID().replace(/\D/g, '').padEnd(17, '0').slice(0, 17)}`;
const start = () => execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', `${port}:6379`, 'redis:7-alpine', 'redis-server', '--maxmemory-policy', 'noeviction'], { stdio: 'ignore' });
const stop = () => { try { execFileSync('docker', ['stop', '-t', '0', name], { stdio: 'ignore' }); } catch { /* already stopped */ } };
let queue;
try {
  start();
  queue = new Queue(queueName, { connection: redisConnection(`redis://127.0.0.1:${port}/9`, true) });
  queue.on('error', () => undefined);
  await queue.waitUntilReady();
  const redisClient = await queue.getBackend().client;
  await prisma.moderationCase.create({ data: { operationId, guildId, actorId: '123456789012345679', targetId: '123456789012345680', action: 'KICK', reason: 'isolated Redis fault test', status: 'requested' } });
  const dispatch = createDispatcher(prisma, queue, () => true, () => undefined);
  await delay(20);
  stop();
  for (let i = 0; i < 100 && redisClient.status === 'ready'; i++) await delay(50);
  assert.notEqual(redisClient.status, 'ready', 'Redis connection did not close');
  await Promise.race([dispatch(), delay(1_000).then(() => { throw new Error('Dispatcher blocked during Redis outage'); })]);
  assert.equal((await prisma.moderationCase.findUnique({ where: { operationId } })).status, 'requested');
  start();
  for (let i = 0; i < 200 && redisClient.status !== 'ready'; i++) await delay(50);
  assert.equal(redisClient.status, 'ready', 'Redis did not reconnect');
  await dispatch();
  assert.equal((await queue.getJob(operationId))?.data.operationId, operationId);
  console.info('Redis outage/recovery passed: PostgreSQL request stayed requested and was republished after reconnection.');
} finally {
  if (queue) {
    try { await queue.obliterate({ force: true }); await queue.close(); } catch { /* Redis may still be unavailable */ }
  }
  stop();
  await prisma.moderationCase.deleteMany({ where: { operationId } });
  await prisma.$disconnect();
}
