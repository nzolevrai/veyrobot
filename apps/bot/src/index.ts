import { Client, Events, GatewayIntentBits } from 'discord.js';
import { Queue } from 'bullmq';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createModerationWorker } from './worker.js';
import { createDispatcher } from './dispatcher.js';
import { z } from 'zod';
import { acquireSingleBotLease } from './single-instance.js';
import { registerInteractionHandler } from './interactions.js';

const lastErrorLogAt = new Map<string, number>();
const errorTotals = new Map<string, number>();
function logThrottled(key: string, message: string, error: unknown): void {
  errorTotals.set(key, (errorTotals.get(key) ?? 0) + 1);
  const now = Date.now();
  if (now - (lastErrorLogAt.get(key) ?? 0) < 60_000) return;
  lastErrorLogAt.set(key, now);
  if (lastErrorLogAt.size > 32) lastErrorLogAt.delete(lastErrorLogAt.keys().next().value!);
  console.error(message, error instanceof Error ? error.name : 'unknown error');
}

const envSchema = z.object({ DISCORD_BOT_TOKEN: z.string().min(1), DISCORD_CLIENT_ID: z.string().min(1), DATABASE_URL: z.string().min(1), REDIS_URL: z.string().url().default('redis://localhost:6379') });
const envResult = envSchema.safeParse(process.env);
if (!envResult.success) {
  const fields = [...new Set(envResult.error.issues.map(issue => issue.path.join('.')))];
  console.error(`Configuration bot invalide. Variables manquantes ou invalides : ${fields.join(', ')}`);
  process.exit(1);
}
const env = envResult.data;
const releaseBotLease = await acquireSingleBotLease(env.DATABASE_URL, () => {
  console.error('Verrou de processus bot perdu : arrêt pour éviter deux exécuteurs actifs.');
  process.exit(1);
});
const [{ rejectPendingAfterDisable, prisma, postgresPool, takePoolAcquireMetrics }, moderation] = await Promise.all([import('@veyrobot/db'), import('@veyrobot/moderation')]);
const { markInterruptedOperationsUncertain, redisConnection } = moderation;
// Uncertain network/5xx responses must reach our durable state machine; avoid
// the REST layer automatically repeating non-idempotent moderation requests.
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0, timeout: 15_000 } });
const connection = redisConnection(env.REDIS_URL);
const queue = new Queue('veyrobot-moderation', { connection: redisConnection(env.REDIS_URL, true) });
queue.on('error', error => logThrottled('moderation-redis-producer', 'Redis producer error', error));
let wakeRequestDispatcher: (() => Promise<void>) | undefined;
const worker = createModerationWorker(client, connection, prisma, moderation, rejectPendingAfterDisable,
  () => { if (wakeRequestDispatcher) setTimeout(() => void wakeRequestDispatcher?.(), 0); });
worker.on('error', error => logThrottled('moderation-redis-worker', 'Redis worker error', error));
let stopBot: (() => Promise<void>) | undefined;
let fatalShutdown: Promise<void> | undefined;
const failProcess = (error: unknown, source: string) => {
  logThrottled(`fatal-${source}`, `Fatal bot error from ${source}`, error);
  if (!fatalShutdown) fatalShutdown = (async () => {
    try {
      if (stopBot) await stopBot();
      else { await worker.close(); await queue.close(); await prisma.$disconnect(); client.destroy(); await releaseBotLease(); }
    } catch (shutdownError) { logThrottled('fatal-shutdown', 'Fatal shutdown cleanup failed', shutdownError); }
    process.exit(1);
  })();
};
client.on(Events.Error, error => failProcess(error, 'discord-client'));
process.on('unhandledRejection', reason => failProcess(reason, 'unhandled-rejection'));
process.on('uncaughtException', error => failProcess(error, 'uncaught-exception'));

client.once(Events.ClientReady, async ready => {
  console.info(`Connecté comme ${ready.user.tag}`);
  await markInterruptedOperationsUncertain(prisma).catch(error => console.error('Could not reconcile interrupted moderation actions', error));
  const ownedShardIds = client.shard?.ids ?? [0];
  const publishPresence = async () => {
    if (!client.isReady()) return;
    const lastSeenAt = new Date();
    await Promise.all(ownedShardIds.map(shardId => prisma.shardPresence.upsert({ where: { shardId }, create: { shardId, lastSeenAt }, update: { lastSeenAt } })));
  };
  const membershipByShard = new Map<number, string[]>();
  for (const guild of ready.guilds.cache.values()) {
    let ids = membershipByShard.get(guild.shardId);
    if (!ids) { ids = []; membershipByShard.set(guild.shardId, ids); }
    ids.push(guild.id);
  }
  let membershipsSynced = false;
  let membershipSyncing = false;
  let membershipRetryTimer: NodeJS.Timeout | undefined;
  const syncGuildMemberships = async () => {
    if (membershipsSynced || membershipSyncing) return;
    membershipSyncing = true;
    try {
    const syncStartedAt = new Date();
    for (const [shardId, guildIds] of membershipByShard) for (let offset = 0; offset < guildIds.length; offset += 500) {
      const batch = guildIds.slice(offset, offset + 500);
      await prisma.guildPresence.updateMany({ where: { guildId: { in: batch } }, data: { shardId, lastSeenAt: syncStartedAt } });
      await prisma.guildPresence.createMany({ data: batch.map(guildId => ({ guildId, shardId, lastSeenAt: syncStartedAt })), skipDuplicates: true });
    }
    await prisma.guildPresence.deleteMany({ where: { shardId: { in: ownedShardIds }, lastSeenAt: { lt: syncStartedAt } } });
    membershipsSynced = true;
    membershipByShard.clear();
    if (membershipRetryTimer) clearInterval(membershipRetryTimer);
    } finally { membershipSyncing = false; }
  };
  await syncGuildMemberships().catch(error => logThrottled('guild-membership-sync', 'guild membership sync failed; retry scheduled', error));
  const dispatchRequested = createDispatcher(prisma, queue, () => client.isReady(), logThrottled);
  wakeRequestDispatcher = dispatchRequested;
  await publishPresence().catch(err => logThrottled('presence-heartbeat', 'initial presence sync failed', err));
  const timer = setInterval(() => void publishPresence().catch(err => logThrottled('presence-heartbeat', 'presence heartbeat failed', err)), 30_000);
  if (!membershipsSynced) membershipRetryTimer = setInterval(() => void syncGuildMemberships().catch(error => logThrottled('guild-membership-sync', 'guild membership sync retry failed', error)), 30_000);
  await dispatchRequested();
  const dispatchTimer = setInterval(() => void dispatchRequested(), 1_000);
  const staleOperationTimer = setInterval(() => void markInterruptedOperationsUncertain(prisma).catch(error => console.error('stale moderation operation reconciliation failed', error)), 60_000);
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let previousElu = performance.eventLoopUtilization();
  const metricsTimer = setInterval(() => { void (async () => {
    const [rows, queueCounts, connections] = await Promise.all([
      prisma.$queryRaw<Array<{ requested: bigint; running: bigint; uncertainActions: bigint; uncertainExpiries: bigint; oldestRequestedSeconds: number | null; overdueExpiries: bigint; oldestExpirySeconds: number | null }>>`
        SELECT
          (SELECT COUNT(*) FROM "ModerationCase" WHERE status = 'requested') AS requested,
          (SELECT COUNT(*) FROM "ModerationCase" WHERE status = 'running') AS running,
          (SELECT COUNT(*) FROM "ModerationCase" WHERE status = 'uncertain') AS "uncertainActions",
          (SELECT COUNT(*) FROM "ModerationCase" WHERE "expiryStatus" = 'uncertain') AS "uncertainExpiries",
          (SELECT EXTRACT(EPOCH FROM now() - MIN("createdAt"))::float8 FROM "ModerationCase" WHERE status = 'requested') AS "oldestRequestedSeconds",
          (SELECT COUNT(*) FROM "ModerationCase" WHERE action = 'TEMPBAN' AND status = 'succeeded' AND "expiryStatus" = 'scheduled' AND "expiresAt" < now()) AS "overdueExpiries",
          (SELECT EXTRACT(EPOCH FROM now() - MIN("expiresAt"))::float8 FROM "ModerationCase" WHERE action = 'TEMPBAN' AND status = 'succeeded' AND "expiryStatus" = 'scheduled' AND "expiresAt" < now()) AS "oldestExpirySeconds"`,
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      prisma.$queryRaw<Array<{ count: number; lockWaiters: number }>>`SELECT COUNT(*)::integer AS count, COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::integer AS "lockWaiters" FROM pg_stat_activity WHERE datname = current_database()`,
    ]);
    const memory = process.memoryUsage();
    const elu = performance.eventLoopUtilization(previousElu);
    previousElu = performance.eventLoopUtilization();
    console.info(JSON.stringify({ metric: 'bot_operational_snapshot', moderation: rows[0], queue: queueCounts, sql: { ...connections[0], pool: { total: postgresPool.totalCount, idle: postgresPool.idleCount, waiting: postgresPool.waitingCount }, acquisition: takePoolAcquireMetrics() },
      errors: Object.fromEntries(errorTotals), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
      eventLoopUtilization: elu.utilization, eventLoopDelayP95Ms: loopDelay.percentile(95) / 1e6 }, (_key, value) => typeof value === 'bigint' ? Number(value) : value));
    loopDelay.reset();
  })().catch(error => logThrottled('operational-metrics', 'Operational snapshot failed', error)); }, 60_000);
  metricsTimer.unref();
  const shutdown = async () => { clearInterval(timer); if (membershipRetryTimer) clearInterval(membershipRetryTimer); clearInterval(dispatchTimer); clearInterval(staleOperationTimer); clearInterval(metricsTimer); loopDelay.disable(); await worker.close(); await queue.close(); await prisma.$disconnect(); client.destroy(); await releaseBotLease(); };
  stopBot = shutdown;
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
});

registerInteractionHandler(client, () => {
  if (wakeRequestDispatcher) void wakeRequestDispatcher().catch(error => logThrottled('moderation-request-wake', 'slash admission dispatcher wake failed', error));
});
client.on(Events.GuildCreate, guild => void prisma.guildPresence.upsert({ where: { guildId: guild.id }, create: { guildId: guild.id, shardId: guild.shardId }, update: { shardId: guild.shardId, lastSeenAt: new Date() } }).catch(error => logThrottled('guild-membership-event', 'guild join presence update failed', error)));
client.on(Events.GuildDelete, guild => void prisma.guildPresence.deleteMany({ where: { guildId: guild.id } }).catch(error => logThrottled('guild-membership-event', 'guild leave presence update failed', error)));

try { await client.login(env.DISCORD_BOT_TOKEN); }
catch (error) {
  await worker.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await releaseBotLease();
  throw error;
}
