import { setTimeout as delay } from 'node:timers/promises';

const db = await import('/workspace/apps/bot/node_modules/@veyrobot/db/dist/index.js');
const moderation = await import('/workspace/apps/bot/node_modules/@veyrobot/moderation/dist/index.js');
const { Queue } = await import('/workspace/apps/bot/node_modules/bullmq/dist/cjs/index.js');
const { createDispatcher } = await import('/workspace/apps/bot/dist/dispatcher.js');
const { createModerationWorker } = await import('/workspace/apps/bot/dist/worker.js');

await db.assertRecoveryAuthorized(db.prisma, process.env.VEYROBOT_RECOVERY_EPOCH);
const calls = { kick: 0, errors: 0 };
const guilds = new Map();
const actorId = '123456789012345679';
const permissions = { bitfield: 8n, has: () => true };
const roles = { highest: { comparePositionTo: () => 1 } };
const fakeGuild = guildId => {
  const guild = {
    id: guildId,
    ownerId: '999999999999999997',
    members: {
      fetch: async ({ user }) => user === actorId
        ? { id: actorId, permissions, roles }
        : { id: user, permissions, roles: { highest: { comparePositionTo: () => -1 } }, kick: async () => { calls.kick++; await delay(50); } },
      fetchMe: async () => ({ id: '999999999999999998', permissions, roles }),
    },
    bans: { fetch: async () => { throw new Error('Unexpected fake ban lookup'); } },
  };
  guilds.set(guildId, guild);
  return guild;
};
const client = {
  isReady: () => true,
  guilds: {
    cache: { get: guildId => guilds.get(guildId) },
    fetch: async guildId => guilds.get(guildId) ?? fakeGuild(guildId),
  },
};
const url = process.env.REDIS_URL;
const queueName = 'veyrobot-moderation';
const queue = new Queue(queueName, { connection: moderation.redisConnection(url, true) });
await queue.waitUntilReady();
let dispatch;
const logThrottled = (_key, _message, _error) => { calls.errors++; };
const worker = createModerationWorker(client, moderation.redisConnection(url), db.prisma, moderation, db.rejectPendingAfterDisable, () => {
  if (dispatch) setImmediate(() => void dispatch());
}, undefined, queueName);
worker.on('error', () => { calls.errors++; });
dispatch = createDispatcher(db.prisma, queue, () => true, logThrottled);
const dispatchTimer = setInterval(() => void dispatch(), 1_000);
const sampleTimer = setInterval(async () => {
  try {
    const [queueCounts, rows] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      db.prisma.moderationCase.groupBy({ by: ['status'], _count: { _all: true }, where: { operationId: { startsWith: 'resource_' } } }),
    ]);
    const memory = process.memoryUsage();
    console.info(JSON.stringify({ event: 'resource_worker_sample', rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, queue: queueCounts, rows, controlledDiscordKickCalls: calls.kick, errors: calls.errors }));
  } catch { calls.errors++; }
}, 2_000);
sampleTimer.unref();
console.info(JSON.stringify({ event: 'resource_worker_ready', discord: 'controlled adapter; no Client, Gateway, or REST connection' }));

async function close() {
  clearInterval(dispatchTimer);
  clearInterval(sampleTimer);
  await worker.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
  await db.prisma.$disconnect().catch(() => undefined);
}
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
