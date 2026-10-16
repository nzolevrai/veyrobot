import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

if (process.env.RUN_REDIS_SATURATION_INTEGRATION !== '1' || process.env.VEYROBOT_ISOLATED_INTEGRATION !== '1') {
  throw new Error('This destructive Redis pressure test requires the explicit isolated CI opt-in.');
}
const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
if (process.env.CI !== 'true' || !databaseUrl || !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) || databaseUrl.pathname !== '/veyrobot') {
  throw new Error('Use the disposable PostgreSQL 17 CI service database for this test.');
}

const [{ prisma, rejectPendingAfterDisable }, moderation, { Queue }] = await Promise.all([
  import('../apps/bot/node_modules/@veyrobot/db/dist/index.js'),
  import('../apps/bot/node_modules/@veyrobot/moderation/dist/index.js'),
  import('../apps/bot/node_modules/bullmq/dist/cjs/index.js'),
]);
const { createDispatcher } = await import('../apps/bot/dist/dispatcher.js');
const { createModerationWorker } = await import('../apps/bot/dist/worker.js');
const suffix = randomUUID().replaceAll('-', '');
const container = `veyrobot-redis-pressure-${suffix.slice(0, 10)}`;
const queueName = `veyrobot-pressure-${suffix.slice(0, 18)}`;
const activeGuildId = snowflake();
const pendingGuildId = snowflake();
const expiryGuildId = snowflake();
const actorId = snowflake();
const activeTargetId = snowflake();
const pendingTargetId = snowflake();
const expiryTargetId = snowflake();
const activeOperationId = `pressure-active-${suffix}`;
const pendingOperationId = `pressure-pending-${suffix}`;
const expiryOperationId = `pressure-expiry-${suffix}`;
const expiryCaseId = `pressure_case_${suffix}`;
let port;
let rawRedis;
let worker;
let queue;
let kickRelease;
let activeKickEntered;
let activeKickCount = 0;
let pendingKickCount = 0;
let unbanCount = 0;
let expiryMarker;
const fillerKeys = [];
const dispatchErrors = [];
const workerErrors = [];
const guildMap = new Map();
const kickGate = new Promise(resolve => { kickRelease = resolve; });
const enteredGate = new Promise(resolve => { activeKickEntered = resolve; });
const actor = { id: actorId, permissions: { bitfield: 8n }, roles: { highest: { comparePositionTo: () => 1 } } };
const botMember = { permissions: { bitfield: 8n, has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } };

function snowflake() { return randomUUID().replace(/\D/g, '').padEnd(18, '7').slice(0, 18); }
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (!allowFailure && result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr.slice(-2000)}`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`);
}
function createGuild(guildId, targetId, { holdKick = false, banReason } = {}) {
  const target = {
    id: targetId,
    roles: { highest: { comparePositionTo: () => -1 } },
    async kick() {
      if (holdKick) { activeKickCount++; activeKickEntered(); await kickGate; }
      else pendingKickCount++;
    },
  };
  const guild = {
    id: guildId,
    ownerId: snowflake(),
    members: {
      fetch: async ({ user }) => user === actorId ? actor : target,
      fetchMe: async () => botMember,
      unban: async () => { unbanCount++; },
    },
    bans: { fetch: async () => ({ reason: banReason }) },
  };
  guildMap.set(guildId, guild);
  return guild;
}
function parseResp(buffer) {
  const end = buffer.indexOf('\r\n');
  if (end < 0) return undefined;
  const marker = String.fromCharCode(buffer[0]);
  const line = buffer.subarray(1, end).toString();
  if (marker === '$') {
    const length = Number(line);
    if (length < 0) return { value: null, consumed: end + 2 };
    if (buffer.length < end + 2 + length + 2) return undefined;
    return { value: buffer.subarray(end + 2, end + 2 + length).toString(), consumed: end + 2 + length + 2 };
  }
  if (marker === '-') return { error: line, consumed: end + 2 };
  if (marker === ':') return { value: Number(line), consumed: end + 2 };
  if (marker === '+') return { value: line, consumed: end + 2 };
  throw new Error(`Unsupported Redis response type ${marker}`);
}
function connectRedis(redisPort) {
  const socket = net.createConnection({ host: '127.0.0.1', port: redisPort });
  let buffer = Buffer.alloc(0);
  let pending;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const response = parseResp(buffer);
    if (response && pending) {
      const current = pending;
      pending = undefined;
      buffer = buffer.subarray(response.consumed);
      response.error ? current.reject(new Error(response.error)) : current.resolve(response.value);
    }
  });
  socket.on('error', error => pending?.reject(error));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({
      command(args) {
        if (pending) return Promise.reject(new Error('Redis probe commands must be sequential.'));
        const payload = Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap(arg => {
          const value = Buffer.from(String(arg));
          return [Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n')];
        })]);
        return new Promise((ok, fail) => { pending = { resolve: ok, reject: fail }; socket.write(payload); });
      },
      close: () => socket.destroy(),
    }));
    socket.once('error', reject);
  });
}
async function createRequest(guildId, targetId, operationId, reason) {
  return moderation.submitModerationAction(prisma, { guildId, actorId, targetId, action: 'KICK', reason, operationId });
}
async function row(operationId) { return prisma.moderationCase.findUnique({ where: { operationId } }); }
async function clearFillerKeys() {
  if (!rawRedis) return;
  for (let offset = 0; offset < fillerKeys.length; offset += 500) {
    await rawRedis.command(['DEL', ...fillerKeys.slice(offset, offset + 500)]).catch(() => undefined);
  }
  fillerKeys.length = 0;
}

try {
  await prisma.guildConfig.createMany({
    data: [activeGuildId, pendingGuildId].map(guildId => ({ guildId, updatedBy: actorId, memberActionsEnabled: true })),
  });
  await createRequest(activeGuildId, activeTargetId, activeOperationId, 'Controlled active action during Redis saturation');
  const redisRun = docker(['run', '--detach', '--rm', '--name', container, '-p', '127.0.0.1::6379', 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'yes', '--appendfsync', 'everysec', '--maxmemory', '24mb', '--maxmemory-policy', 'noeviction']);
  assert.ok(redisRun.stdout, 'isolated Redis 7 container started');
  const portOutput = await until('ephemeral Redis port', () => {
    const result = docker(['port', container, '6379/tcp'], true);
    const match = result.stdout.match(/:(\d+)\s*$/);
    return match ? Number(match[1]) : undefined;
  });
  port = portOutput;
  rawRedis = await connectRedis(port);
  await until('Redis PONG', async () => (await rawRedis.command(['PING'])) === 'PONG');
  const serverInfo = await rawRedis.command(['INFO', 'server']);
  const redisVersion = serverInfo.match(/redis_version:([^\r\n]+)/)?.[1];
  assert.match(redisVersion ?? '', /^7\./, 'saturation runs against Redis 7');

  const redisUrl = `redis://127.0.0.1:${port}`;
  const consumerConnection = moderation.redisConnection(redisUrl);
  const producerConnection = moderation.redisConnection(redisUrl, true);
  queue = new Queue(queueName, { connection: producerConnection });
  queue.on('error', error => workerErrors.push({ source: 'producer', name: error?.name ?? 'unknown' }));
  await queue.waitUntilReady();
  createGuild(activeGuildId, activeTargetId, { holdKick: true });
  createGuild(pendingGuildId, pendingTargetId);
  const client = { isReady: () => true, guilds: { cache: { get: id => guildMap.get(id) } } };
  worker = createModerationWorker(client, consumerConnection, prisma, moderation, rejectPendingAfterDisable, () => undefined, undefined, queueName);
  worker.on('error', error => workerErrors.push({ source: 'worker', name: error?.name ?? 'unknown' }));
  await queue.add('moderation-action', { guildId: activeGuildId, operationId: activeOperationId }, { jobId: activeOperationId, attempts: 1, removeOnComplete: true, removeOnFail: true });
  await enteredGate;
  await createRequest(pendingGuildId, pendingTargetId, pendingOperationId, 'Must remain durable while Redis refuses writes');

  expiryMarker = `pressure-marker-${suffix}`;
  await prisma.guildConfig.create({ data: { guildId: expiryGuildId, updatedBy: actorId, memberActionsEnabled: true } });
  await prisma.moderationCase.create({ data: {
    id: expiryCaseId, operationId: expiryOperationId, guildId: expiryGuildId, actorId, targetId: expiryTargetId,
    action: 'TEMPBAN', reason: 'Due expiry retained through Redis outage', status: 'succeeded', durationMinutes: 1,
    expiresAt: new Date(Date.now() - 60_000), banMarker: expiryMarker, banGeneration: 1, expiryStatus: 'scheduled',
  } });
  await prisma.guildTargetDecision.create({ data: {
    guildId: expiryGuildId, targetId: expiryTargetId, generation: 1, latestOperationId: expiryOperationId,
    appliedGeneration: 1, appliedOperationId: expiryOperationId,
  } });
  createGuild(expiryGuildId, expiryTargetId, { banReason: `temporary ban [${expiryMarker}]` });

  let dispatcherQueryCount = 0;
  const dispatchStore = {
    $queryRaw: (...args) => { dispatcherQueryCount++; return prisma.$queryRaw(...args); },
    moderationCase: prisma.moderationCase,
  };
  const dispatch = createDispatcher(dispatchStore, queue, () => true, (key, message, error) => {
    dispatchErrors.push({ key, message, errorName: error instanceof Error ? error.name : 'unknown' });
  });
  await delay(20); // let the dispatcher's initial Redis-ready promise settle

  const filler = 'x'.repeat(1024 * 1024);
  let largeChunkRejected = false;
  for (let i = 0; i < 40; i++) {
    const key = `pressure:filler:${i}`;
    try { await rawRedis.command(['SET', key, filler]); fillerKeys.push(key); }
    catch (error) {
      assert.match(error.message, /^OOM /, 'Redis refused a write because maxmemory was reached');
      largeChunkRejected = true;
      break;
    }
  }
  assert.ok(largeChunkRejected, 'a 1 MiB write proves the isolated Redis 7 instance reached noeviction maxmemory');
  const smallFiller = 'x'.repeat(1024);
  let smallChunkRejected = false;
  for (let i = 40; i < 32_040; i++) {
    const key = `pressure:filler:${i}`;
    try { await rawRedis.command(['SET', key, smallFiller]); fillerKeys.push(key); }
    catch (error) {
      assert.match(error.message, /^OOM /, 'Redis rejects even a small write when effectively full');
      smallChunkRejected = true;
      break;
    }
  }
  assert.ok(smallChunkRejected, 'fine-grained filling leaves less than 1 KiB for a BullMQ write');
  const oomRejectedWrites = 2;
  const firstFailureAt = Date.now();
  await dispatch();
  assert.equal(dispatchErrors.length, 1, 'a refused publish is diagnosed once');
  assert.equal(dispatchErrors[0].key, 'moderation-queue-dispatch');
  assert.match(dispatchErrors[0].message, /PostgreSQL request remains durable/);
  assert.match(dispatchErrors[0].errorName, /Error/);
  assert.equal((await row(pendingOperationId)).status, 'requested', 'failed Redis enqueue does not lose accepted PostgreSQL work');
  assert.equal((await prisma.moderationCase.findUnique({ where: { id: expiryCaseId } })).expiryStatus, 'scheduled', 'due expiry remains durable');
  assert.equal(activeKickCount, 1, 'the already active controlled Discord operation was not repeated');

  for (let i = 0; i < 8; i++) await dispatch();
  assert.equal(dispatchErrors.length, 1, 'repeated wakes are held by exponential cooldown rather than log/retry storm');
  assert.equal(dispatcherQueryCount, 1, 'cooldown avoids repeated PostgreSQL outbox scans');

  kickRelease();
  await until('active action durable completion while Redis is saturated', async () => (await row(activeOperationId))?.status === 'succeeded');
  await clearFillerKeys();
  const remainingBackoff = Math.max(0, firstFailureAt + 1_010 - Date.now());
  if (remainingBackoff) await delay(remainingBackoff);
  await dispatch();

  await until('pending operation and due expiry to reconcile after Redis recovers', async () => {
    const [pending, expiry] = await Promise.all([
      row(pendingOperationId), prisma.moderationCase.findUnique({ where: { id: expiryCaseId } }),
    ]);
    return pending?.status === 'succeeded' && expiry?.expiryStatus === 'succeeded';
  });
  await until('active BullMQ delivery to acknowledge or redeliver safely after Redis recovers', async () => {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return Object.values(counts).every(count => count === 0);
  }, 45_000);
  assert.equal((await row(activeOperationId)).status, 'succeeded');
  assert.equal((await row(pendingOperationId)).status, 'succeeded');
  assert.equal((await prisma.moderationCase.findUnique({ where: { id: expiryCaseId } })).expiryStatus, 'succeeded');
  assert.equal(activeKickCount, 1, 'lost/late BullMQ acknowledgement cannot produce a second Discord mutation');
  assert.equal(pendingKickCount, 1, 'the durable request is executed once after recovery');
  assert.equal(unbanCount, 1, 'the overdue expiry is reconciled once after Redis recovers');
  await dispatch();
  assert.equal(activeKickCount + pendingKickCount, 2, 'a later reconciliation does not repeat completed actions');
  assert.equal(unbanCount, 1, 'a later reconciliation does not repeat a completed expiry');
  const memoryInfo = await rawRedis.command(['INFO', 'memory']);
  const usedMemoryBytes = Number(memoryInfo.match(/used_memory:(\d+)/)?.[1]);
  const maxMemoryBytes = Number(memoryInfo.match(/maxmemory:(\d+)/)?.[1]);
  console.info(JSON.stringify({
    event: 'redis_saturation_integration_passed', redisVersion, oomRejectedWrites, usedMemoryBytes, maxMemoryBytes,
    acceptedRows: 2, actionsAfterRecovery: activeKickCount + pendingKickCount, expiriesAfterRecovery: unbanCount,
    dispatcherErrors: dispatchErrors.length, dispatcherOutboxQueriesDuringBackoff: dispatcherQueryCount,
    workerRedisErrors: workerErrors.length,
  }));
} finally {
  kickRelease?.();
  if (rawRedis && fillerKeys.length) await clearFillerKeys();
  if (worker) await worker.close().catch(() => undefined);
  if (queue) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  }
  rawRedis?.close();
  docker(['rm', '-f', container], true);
  await prisma.moderationCase.deleteMany({ where: { OR: [{ operationId: { in: [activeOperationId, pendingOperationId, expiryOperationId] } }, { id: expiryCaseId }] } }).catch(() => undefined);
  await prisma.guildTargetDecision.deleteMany({ where: { guildId: { in: [activeGuildId, pendingGuildId, expiryGuildId] } } }).catch(() => undefined);
  await prisma.guildConfig.deleteMany({ where: { guildId: { in: [activeGuildId, pendingGuildId, expiryGuildId] } } }).catch(() => undefined);
  await prisma.$disconnect();
}
