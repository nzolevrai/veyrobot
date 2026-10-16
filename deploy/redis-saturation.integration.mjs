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
const testStartedAt = Date.now();
const container = `veyrobot-redis-pressure-${suffix.slice(0, 10)}`;
const queueName = `veyrobot-pressure-${suffix.slice(0, 18)}`;
const activeGuildId = snowflake();
const pendingGuildId = snowflake();
const expiryGuildId = snowflake();
const oomPendingGuildId = snowflake();
const oomExpiryGuildId = snowflake();
const actorId = snowflake();
const activeTargetId = snowflake();
const pendingTargetId = snowflake();
const expiryTargetId = snowflake();
const oomPendingTargetId = snowflake();
const oomExpiryTargetId = snowflake();
const activeOperationId = `pressure-active-${suffix}`;
const pendingOperationId = `pressure-pending-${suffix}`;
const expiryOperationId = `pressure-expiry-${suffix}`;
const oomOperationId = `pressure-oom-active-${suffix}`;
const oomPendingOperationId = `pressure-oom-pending-${suffix}`;
const oomExpiryOperationId = `pressure-oom-expiry-${suffix}`;
const expiryCaseId = `pressure_case_${suffix}`;
const oomExpiryCaseId = `pressure_oom_case_${suffix}`;
let port;
let rawRedis;
let worker;
let queue;
let dispatch;
let kickRelease;
let activeKickEntered;
let activeKickCount = 0;
let pendingKickCount = 0;
let unbanCount = 0;
let expiryMarker;
let oomVolume;
let oomKickCount = 0;
let oomKickWasEntered = false;
let oomKickRelease;
let oomQueueDeliveries = 0;
const oomKickGate = new Promise(resolve => { oomKickRelease = resolve; });
const fillerKeys = [];
const dispatchErrors = [];
const dispatchAttempts = [];
const workerErrors = [];
const queueErrors = [];
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
async function connectRedisRetry(redisPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await connectRedis(redisPort); }
    catch (error) { lastError = error; await delay(100); }
  }
  throw new Error(`Redis did not accept the probe connection within ${timeoutMs} ms (${lastError instanceof Error ? lastError.code ?? lastError.name : 'unknown'}).`);
}
async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const reservedPort = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return reservedPort;
}
function createGuild(guildId, targetId, { holdKick = false, banReason, oomHoldKick = false } = {}) {
  const target = {
    id: targetId,
    roles: { highest: { comparePositionTo: () => -1 } },
    async kick() {
      if (holdKick) { activeKickCount++; activeKickEntered(); await kickGate; }
      else if (oomHoldKick) { oomKickCount++; oomKickWasEntered = true; console.info(JSON.stringify({ event: 'controlled_discord_mutation_held', scenario: 'redis_cgroup_oom' })); await oomKickGate; }
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
      clearTimeout(current.timer);
      buffer = buffer.subarray(response.consumed);
      response.error ? current.reject(new Error(response.error)) : current.resolve(response.value);
    }
  });
  const rejectPending = error => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    current.reject(error);
  };
  socket.on('error', error => rejectPending(error));
  socket.on('close', () => rejectPending(new Error('Redis connection closed before a response.')));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({
      command(args) {
        if (pending) return Promise.reject(new Error('Redis probe commands must be sequential.'));
        const payload = Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap(arg => {
          const value = Buffer.from(String(arg));
          return [Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n')];
        })]);
        return new Promise((ok, fail) => {
          const timer = setTimeout(() => rejectPending(new Error('Redis probe command timed out after 10 seconds.')), 10_000);
          pending = { resolve: ok, reject: fail, timer };
          socket.write(payload);
        });
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
  port = await reserveLoopbackPort();
  oomVolume = `veyrobot-pressure-aof-${suffix.slice(0, 12)}`;
  docker(['volume', 'create', oomVolume]);
  const redisRun = docker(['run', '--detach', '--memory=128m', '--memory-swap=128m', '--name', container, '-p', `127.0.0.1:${port}:6379`, '-v', `${oomVolume}:/data`, 'redis:7-alpine', 'redis-server', '--dir', '/data', '--save', '', '--appendonly', 'yes', '--appendfsync', 'everysec', '--maxmemory', '24mb', '--maxmemory-policy', 'noeviction']);
  assert.ok(redisRun.stdout, 'isolated Redis 7 container started');
  const saturationHostConfig = JSON.parse(docker(['inspect', container, '--format', '{{json .HostConfig}}']).stdout);
  assert.equal(saturationHostConfig.Memory, 128 * 1024 ** 2, 'the Redis integration container receives the bounded cgroup limit');
  assert.equal(saturationHostConfig.MemorySwap, 128 * 1024 ** 2, 'maxmemory/OOM scenarios do not silently use container swap');
  rawRedis = await connectRedis(port);
  await until('Redis PONG', async () => (await rawRedis.command(['PING'])) === 'PONG');
  const serverInfo = await rawRedis.command(['INFO', 'server']);
  const redisVersion = serverInfo.match(/redis_version:([^\r\n]+)/)?.[1];
  assert.match(redisVersion ?? '', /^7\./, 'saturation runs against Redis 7');

  let redisUrl = `redis://127.0.0.1:${port}`;
  const consumerConnection = moderation.redisConnection(redisUrl);
  const producerConnection = moderation.redisConnection(redisUrl, true);
  queue = new Queue(queueName, { connection: producerConnection });
  queue.on('error', error => queueErrors.push({ at: Date.now(), source: 'producer', name: error?.name ?? 'unknown' }));
  await queue.waitUntilReady();
  createGuild(activeGuildId, activeTargetId, { holdKick: true });
  createGuild(pendingGuildId, pendingTargetId);
  const client = { isReady: () => true, guilds: { cache: { get: id => guildMap.get(id) } } };
  worker = createModerationWorker(client, consumerConnection, prisma, moderation, rejectPendingAfterDisable, () => undefined, undefined, queueName, { lockDuration: 3_000, stalledInterval: 1_000 });
  worker.on('active', job => { if (job.id === oomOperationId) oomQueueDeliveries++; });
  worker.on('error', error => workerErrors.push({ at: Date.now(), source: 'worker', name: error?.name ?? 'unknown' }));
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
  dispatch = createDispatcher(dispatchStore, queue, () => true, (key, message, error) => {
    dispatchErrors.push({ at: Date.now(), key, message, errorName: error instanceof Error ? error.name : 'unknown', errorMessage: error instanceof Error ? error.message : String(error) });
  }, attempt => dispatchAttempts.push({ at: Date.now(), ...attempt }));
  await until('BullMQ producer connection ready before applying Redis memory pressure', async () => (await queue.getBackend().client).status === 'ready');

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
  assert.match(dispatchErrors[0].errorMessage, /^OOM /, 'BullMQ publication failed with Redis maxmemory OOM, not a connection failure');
  assert.equal((await row(pendingOperationId)).status, 'requested', 'failed Redis enqueue does not lose accepted PostgreSQL work');
  assert.equal((await prisma.moderationCase.findUnique({ where: { id: expiryCaseId } })).expiryStatus, 'scheduled', 'due expiry remains durable');
  assert.equal(activeKickCount, 1, 'the already active controlled Discord operation was not repeated');

  const outboxQueriesBeforeCooldownWakes = dispatcherQueryCount;
  const errorsBeforeCooldownWakes = dispatchErrors.length;
  for (let i = 0; i < 8; i++) await dispatch();
  const dispatcherOutboxQueriesDuringBackoff = dispatcherQueryCount - outboxQueriesBeforeCooldownWakes;
  const dispatcherErrorsDuringBackoff = dispatchErrors.length - errorsBeforeCooldownWakes;
  assert.equal(dispatchErrors.length, 1, 'repeated wakes are held by exponential cooldown rather than log/retry storm');
  assert.equal(dispatcherOutboxQueriesDuringBackoff, 0, 'cooldown avoids repeated PostgreSQL outbox scans');
  assert.equal(dispatcherErrorsDuringBackoff, 0, 'cooldown emits no additional diagnostics');

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

  // Separate cgroup OOM test: disable Redis maxmemory only after the maxmemory refusal assertions above.
  // PostgreSQL remains the durable outbox while Redis itself is killed under a bounded 128 MiB cgroup.
  await prisma.guildConfig.createMany({ data: [oomPendingGuildId, oomExpiryGuildId].map(guildId => ({ guildId, updatedBy: actorId, memberActionsEnabled: true })) });
  createGuild(activeGuildId, activeTargetId, { oomHoldKick: true });
  createGuild(oomPendingGuildId, oomPendingTargetId);
  createGuild(oomExpiryGuildId, oomExpiryTargetId, { banReason: `temporary ban [pressure-oom-marker-${suffix}]` });
  assert.equal(await rawRedis.command(['CONFIG', 'SET', 'appendfsync', 'always']), 'OK');
  await createRequest(activeGuildId, activeTargetId, oomOperationId, 'Controlled mutation in flight during Redis cgroup OOM');
  const oomExpiryMarker = `pressure-oom-marker-${suffix}`;
  await dispatch();
  await until('controlled Discord adapter entered during OOM scenario', () => oomKickWasEntered, 15_000);
  await until('active BullMQ job exists before Redis outage', async () => {
    const activeJob = await queue.getJob(oomOperationId);
    return activeJob ? await activeJob.getState() === 'active' : false;
  });
  const beforeOomPersistence = await rawRedis.command(['INFO', 'persistence']);
  assert.match(beforeOomPersistence, /^aof_last_write_status:ok$/m);
  assert.match(beforeOomPersistence, /^aof_pending_bio_fsync:0$/m);
  assert.equal(await rawRedis.command(['SET', `oom-aof-sentinel:${suffix}`, suffix]), 'OK', 'write a sentinel with synchronous AOF before the cgroup OOM');
  const aofDisabled = await rawRedis.command(['CONFIG', 'SET', 'appendonly', 'no']);
  assert.equal(aofDisabled, 'OK', 'stop persisting synthetic OOM filler after the active BullMQ job and sentinel were fsynced');
  await until('AOF disabled before non-durable OOM filler', async () => /aof_enabled:0/.test(await rawRedis.command(['INFO', 'persistence'])));
  const configured = await rawRedis.command(['CONFIG', 'SET', 'maxmemory', '0']);
  assert.equal(configured, 'OK', 'cgroup OOM phase disables Redis maxmemory so it cannot be confused with a noeviction refusal');
  assert.match(await rawRedis.command(['INFO', 'memory']), /^maxmemory:0$/m, 'cgroup test confirms logical Redis maxmemory is disabled');
  const oomBlock = 'q'.repeat(1024 * 1024);
  let oomWriterStatus = 0;
  for (let i = 0; i < 256; i++) {
    try { await rawRedis.command(['SET', `cgroup-oom:${i}`, oomBlock]); }
    catch { oomWriterStatus = 1; break; }
    const state = JSON.parse(docker(['inspect', container, '--format', '{{json .State}}']).stdout);
    if (!state.Running) { oomWriterStatus = 1; break; }
  }
  await until('Redis cgroup OOM kill (not maxmemory rejection)', async () => {
    const result = docker(['inspect', container, '--format', '{{json .State}}'], true);
    try { return JSON.parse(result.stdout).OOMKilled === true; } catch { return false; }
  }, 30_000);
  console.info(JSON.stringify({ event: 'redis_cgroup_oom_confirmed', containerLimitBytes: 128 * 1024 ** 2 }));
  const oomState = JSON.parse(docker(['inspect', container, '--format', '{{json .State}}']).stdout);
  assert.equal(oomState.OOMKilled, true, 'Docker confirms the Redis process was cgroup OOM-killed');
  const outageStartedAt = Date.now();
  const queueClientBeforeRestart = await queue.getBackend().client;
  const workerClientBeforeRestart = await worker.getBackend().client;
  await until('same BullMQ clients detect Redis outage', () => queueClientBeforeRestart.status !== 'ready' && workerClientBeforeRestart.status !== 'ready', 5_000);
  await createRequest(oomPendingGuildId, oomPendingTargetId, oomPendingOperationId, 'Durable while Redis is OOM-killed');
  await prisma.moderationCase.create({ data: {
    id: oomExpiryCaseId, operationId: oomExpiryOperationId, guildId: oomExpiryGuildId, actorId, targetId: oomExpiryTargetId,
    action: 'TEMPBAN', reason: 'Due expiry retained through Redis cgroup OOM', status: 'succeeded', durationMinutes: 1,
    expiresAt: new Date(Date.now() - 60_000), banMarker: oomExpiryMarker, banGeneration: 1, expiryStatus: 'scheduled',
  } });
  await prisma.guildTargetDecision.create({ data: {
    guildId: oomExpiryGuildId, targetId: oomExpiryTargetId, generation: 1, latestOperationId: oomExpiryOperationId,
    appliedGeneration: 1, appliedOperationId: oomExpiryOperationId,
  } });
  assert.equal((await row(oomPendingOperationId)).status, 'requested', 'PostgreSQL retains the pending accepted operation across Redis OOM');
  assert.equal((await prisma.moderationCase.findUnique({ where: { id: oomExpiryCaseId } })).expiryStatus, 'scheduled', 'PostgreSQL retains the due expiry across Redis OOM');
  assert.equal(oomKickCount, 1, 'controlled action reached the fake Discord adapter once before OOM');
  rawRedis.close();
  rawRedis = undefined;
  oomKickRelease();
  console.info(JSON.stringify({ event: 'controlled_discord_mutation_released_after_oom' }));
  await until('in-flight action result persisted after Redis OOM', async () => (await row(oomOperationId))?.status === 'succeeded');
  const outageErrorCountBeforeRestart = workerErrors.length + queueErrors.length;
  docker(['start', container]);
  assert.match(docker(['port', container, '6379/tcp']).stdout, new RegExp(`:${port}$`), 'published Redis port remains stable through container restart');
  rawRedis = await connectRedisRetry(port);
  await until('Redis reconnect after AOF restart', async () => (await rawRedis.command(['PING']).catch(() => '')) === 'PONG', 30_000);
  assert.equal(await rawRedis.command(['GET', `oom-aof-sentinel:${suffix}`]), suffix, 'the AOF volume restores a key fsynced before the OOM');
  const queueClientAfterRestart = await queue.getBackend().client;
  const workerClientAfterRestart = await worker.getBackend().client;
  assert.strictEqual(queueClientAfterRestart, queueClientBeforeRestart, 'the producer reconnects on its original live client');
  assert.strictEqual(workerClientAfterRestart, workerClientBeforeRestart, 'the consumer reconnects on its original live client');
  await until('existing producer and worker clients return to ready', () => queueClientBeforeRestart.status === 'ready' && workerClientBeforeRestart.status === 'ready', 30_000);

  // Keep the production one-second dispatcher cadence. Nothing deletes or
  // reinserts Redis job/lock state during the recovery proof.
  const recoveryTimer = setInterval(() => { void dispatch(); }, 1_000);
  try {
    await until('PostgreSQL request and due expiry complete after live-client recovery', async () => {
      const [pending, expiry] = await Promise.all([
        row(oomPendingOperationId), prisma.moderationCase.findUnique({ where: { id: oomExpiryCaseId } }),
      ]);
      return pending?.status === 'succeeded' && expiry?.expiryStatus === 'succeeded';
    }, 90_000);
    await until('AOF-restored active job is recovered by BullMQ and queue drains', async () => {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      return oomQueueDeliveries >= 2 && Object.values(counts).every(count => count === 0);
    }, 90_000);
  } finally {
    clearInterval(recoveryTimer);
  }
  assert.ok(oomQueueDeliveries >= 2, 'BullMQ stalled recovery redelivered the AOF-restored active job without manual injection');
  assert.ok(dispatchAttempts.some(attempt => attempt.operationId === oomPendingOperationId), 'the same production dispatcher published the durable pending request');
  assert.ok(dispatchAttempts.some(attempt => attempt.operationId === `expiry-${oomExpiryCaseId}`), 'the same production dispatcher published the due PostgreSQL expiry');
  const outageEnqueueAttempts = dispatchAttempts.filter(attempt => attempt.at >= outageStartedAt).length;
  assert.ok(outageEnqueueAttempts <= 4, `outage/recovery publication attempts remain bounded (observed ${outageEnqueueAttempts})`);
  assert.ok(workerErrors.length + queueErrors.length - outageErrorCountBeforeRestart <= 20, 'client disconnect/reconnect diagnostics are bounded');
  assert.ok(dispatchErrors.filter(error => error.at >= outageStartedAt).length <= 4, 'dispatcher retry diagnostics remain bounded during the Redis outage');
  assert.equal((await row(oomOperationId)).status, 'succeeded');
  assert.equal((await row(oomPendingOperationId)).status, 'succeeded');
  assert.equal((await prisma.moderationCase.findUnique({ where: { id: oomExpiryCaseId } })).expiryStatus, 'succeeded');
  assert.equal(oomKickCount, 1, 'redelivery after cgroup OOM cannot repeat a confirmed mutation');
  assert.equal(pendingKickCount, 2, 'durable pending operations execute exactly once after recovery');
  assert.equal(unbanCount, 2, 'due expiry is reconciled exactly once after recovery');
  const memoryInfo = await rawRedis.command(['INFO', 'memory']);
  const usedMemoryBytes = Number(memoryInfo.match(/used_memory:(\d+)/)?.[1]);
  const maxMemoryBytes = Number(memoryInfo.match(/maxmemory:(\d+)/)?.[1]);
  console.info(JSON.stringify({
    event: 'redis_saturation_integration_passed', elapsedMs: Date.now() - testStartedAt, redisVersion, oomRejectedWrites, usedMemoryBytes, maxMemoryBytes,
    acceptedRows: 2, actionsAfterRecovery: activeKickCount + pendingKickCount, expiriesAfterRecovery: unbanCount,
    dispatcherErrors: dispatchErrors.length, dispatcherOutboxQueriesDuringBackoff, dispatcherErrorsDuringBackoff,
    workerRedisErrors: workerErrors.length, queueRedisErrors: queueErrors.length, oomQueueDeliveries,
    cgroupOom: { containerLimitBytes: 128 * 1024 ** 2, oomKilled: oomState.OOMKilled, exitCode: oomState.ExitCode, oomWriterStopped: oomWriterStatus === 1, inFlightMutations: oomKickCount, pendingRowsRecovered: 1, expiriesRecovered: 1, duplicateMutations: false, aofVolume: 'isolated; Redis 7 appendonly everysec' },
  }));
} finally {
  kickRelease?.();
  oomKickRelease?.();
  if (rawRedis && fillerKeys.length) await clearFillerKeys();
  if (worker) await Promise.race([worker.close(true).catch(() => undefined), delay(3_000)]);
  if (queue) await Promise.race([queue.close().catch(() => undefined), delay(3_000)]);
  rawRedis?.close();
  docker(['rm', '-f', container], true);
  if (oomVolume) docker(['volume', 'rm', '-f', oomVolume], true);
  await prisma.moderationCase.deleteMany({ where: { OR: [{ operationId: { in: [activeOperationId, pendingOperationId, expiryOperationId, oomOperationId, oomPendingOperationId, oomExpiryOperationId] } }, { id: { in: [expiryCaseId, oomExpiryCaseId] } }] } }).catch(() => undefined);
  await prisma.guildTargetDecision.deleteMany({ where: { guildId: { in: [activeGuildId, pendingGuildId, expiryGuildId, oomPendingGuildId, oomExpiryGuildId] } } }).catch(() => undefined);
  await prisma.guildConfig.deleteMany({ where: { guildId: { in: [activeGuildId, pendingGuildId, expiryGuildId, oomPendingGuildId, oomExpiryGuildId] } } }).catch(() => undefined);
  await prisma.$disconnect();
}
