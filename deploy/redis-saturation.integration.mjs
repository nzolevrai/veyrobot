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
const mib = 1024 * 1024;
const minimumPressureMarginBytes = 4 * mib;
// Earlier runs observed up to 1.39 MiB variation in normal-client buffers.
// Keep an 8 MiB preparation reserve (over 5x that observation) above the
// required 4 MiB floor, instead of positioning maxmemory at that exact edge.
const pressurePreparationReserveBytes = 8 * mib;
const pressurePreparationTargetBytes = minimumPressureMarginBytes + pressurePreparationReserveBytes;
const minimumPressureMaxMemoryBytes = 8 * mib;
const maximumPressureAdjustments = 3;
const container = `veyrobot-redis-pressure-${suffix.slice(0, 10)}`;
const queueName = `veyrobot-pressure-${suffix.slice(0, 18)}`;
const activeGuildId = snowflake();
const pendingGuildId = snowflake();
const expiryGuildId = snowflake();
const oomPendingGuildId = snowflake();
const oomExpiryGuildId = snowflake();
const preExpiryGuildId = snowflake();
const postExpiryGuildId = snowflake();
const actorId = snowflake();
const activeTargetId = snowflake();
const pendingTargetId = snowflake();
const expiryTargetId = snowflake();
const oomPendingTargetId = snowflake();
const oomExpiryTargetId = snowflake();
const preExpiryTargetId = snowflake();
const postExpiryTargetId = snowflake();
const activeOperationId = `pressure-active-${suffix}`;
const pendingOperationId = `pressure-pending-${suffix}`;
const expiryOperationId = `pressure-expiry-${suffix}`;
const oomOperationId = `pressure-oom-active-${suffix}`;
const oomPendingOperationId = `pressure-oom-pending-${suffix}`;
const oomExpiryOperationId = `pressure-oom-expiry-${suffix}`;
const preExpiryOperationId = `pressure-pre-expiry-${suffix}`;
const postExpiryOperationId = `pressure-post-expiry-${suffix}`;
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
let pressureActiveDeliveries = 0;
let pressureActiveStalled = 0;
let pressureActiveCompletions = 0;
let pressureActiveFailures = 0;
let pendingKickCount = 0;
let unbanCount = 0;
let expiryMarker;
let oomVolume;
let oomKickCount = 0;
let oomKickWasEntered = false;
let oomKickRelease;
let oomQueueDeliveries = 0;
const recoveryScenarios = new Map();
const workerFailures = [];
const guildBusySkips = [];
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
async function within(label, promise, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function until(label, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await within(label, Promise.resolve().then(check), remaining);
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
  try {
    await within('loopback port reservation', new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    }), 5_000);
  } catch (error) {
    server.close();
    throw error;
  }
  const reservedPort = server.address().port;
  await within('loopback port release', new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5_000);
  return reservedPort;
}
function createGuild(guildId, targetId, { holdKick = false, banReason, oomHoldKick = false, recovery } = {}) {
  const target = {
    id: targetId,
    roles: { highest: { comparePositionTo: () => -1 } },
    async kick() {
      if (holdKick) { activeKickCount++; activeKickEntered(); await kickGate; }
      else if (oomHoldKick) { oomKickCount++; oomKickWasEntered = true; console.info(JSON.stringify({ event: 'controlled_discord_mutation_held', scenario: 'redis_cgroup_oom' })); await oomKickGate; }
      else if (recovery) { recovery.mutations++; recovery.entered(); await recovery.gate; }
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
  socket.setTimeout(10_000, () => { socket.destroy(new Error('Redis probe socket timed out after 10 seconds.')); });
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
  return within(`PostgreSQL admission for ${operationId}`, moderation.submitModerationAction(prisma, { guildId, actorId, targetId, action: 'KICK', reason, operationId }), 10_000);
}
async function row(operationId) { return within(`PostgreSQL read for ${operationId}`, prisma.moderationCase.findUnique({ where: { operationId } }), 10_000); }
async function clearFillerKeys() {
  if (!rawRedis) return;
  for (let offset = 0; offset < fillerKeys.length; offset += 500) {
    await rawRedis.command(['DEL', ...fillerKeys.slice(offset, offset + 500)]).catch(() => undefined);
  }
  fillerKeys.length = 0;
}
async function logRedisPressureSnapshot(label) {
  const info = await rawRedis.command(['INFO', 'memory']);
  const stats = await rawRedis.command(['INFO', 'stats']);
  const value = name => Number(info.match(new RegExp(`^${name}:(\\d+)`, 'm'))?.[1] ?? 0);
  const stat = name => Number(stats.match(new RegExp(`^${name}:(\\d+)`, 'm'))?.[1] ?? 0);
  const databaseKeys = await rawRedis.command(['DBSIZE']);
  const snapshot = {
    event: 'redis_pressure_checkpoint', label,
    usedMemoryBytes: value('used_memory'), maxMemoryBytes: value('maxmemory'),
    usedMemoryDatasetBytes: value('used_memory_dataset'), usedMemoryOverheadBytes: value('used_memory_overhead'),
    allocatorAllocatedBytes: value('allocator_allocated'), normalClientBufferBytes: value('mem_clients_normal'),
    aofBufferBytes: value('mem_aof_buffer'),
    memoryHeadroomBytes: value('maxmemory') - value('used_memory'),
    minimumPressureMarginBytes, pressurePreparationTargetBytes, pressurePreparationReserveBytes,
    databaseKeys,
    trackedFillerKeys: fillerKeys.length,
    nonFillerKeys: databaseKeys - fillerKeys.length,
    expiredKeys: stat('expired_keys'), evictedKeys: stat('evicted_keys'),
    pressureActiveDeliveries, pressureActiveStalled, pressureActiveCompletions, pressureActiveFailures,
  };
  console.info(JSON.stringify(snapshot));
  return snapshot;
}
function makeRecoveryGate(operationId) {
  let enter;
  let release;
  const scenario = {
    operationId, deliveries: 0, mutations: 0, stalled: 0, failures: [], completions: 0,
    entered: () => enter(),
    gate: new Promise(resolve => { release = resolve; }),
    enteredGate: new Promise(resolve => { enter = resolve; }),
    release: () => release(),
  };
  recoveryScenarios.set(operationId, scenario);
  return scenario;
}
async function restartRedisControlled({ holdMs = 0, label }) {
  const queueClient = await within(`${label}: producer client`, queue.getBackend().client, 5_000);
  const workerClient = await within(`${label}: worker client`, worker.getBackend().client, 5_000);
  docker(['stop', '--time=1', container]);
  rawRedis?.close();
  rawRedis = undefined;
  await until(`${label}: both live BullMQ clients detect Redis stop`, () => queueClient.status !== 'ready' && workerClient.status !== 'ready', 8_000);
  if (holdMs > 0) await delay(holdMs);
  docker(['start', container]);
  assert.match(docker(['port', container, '6379/tcp']).stdout, new RegExp(`:${port}$`), `${label}: Redis resumes on the original port`);
  rawRedis = await connectRedisRetry(port, 15_000);
  await until(`${label}: Redis accepts PING`, async () => (await rawRedis.command(['PING']).catch(() => '')) === 'PONG', 15_000);
  await until(`${label}: original queue and worker clients reconnect`, () => queueClient.status === 'ready' && workerClient.status === 'ready', 20_000);
  assert.strictEqual(await queue.getBackend().client, queueClient, `${label}: producer client identity is unchanged`);
  assert.strictEqual(await worker.getBackend().client, workerClient, `${label}: worker client identity is unchanged`);
}

try {
  await within('test guild setup', prisma.guildConfig.createMany({
    data: [activeGuildId, pendingGuildId].map(guildId => ({ guildId, updatedBy: actorId, memberActionsEnabled: true })),
  }), 10_000);
  port = await reserveLoopbackPort();
  oomVolume = `veyrobot-pressure-aof-${suffix.slice(0, 12)}`;
  docker(['volume', 'create', oomVolume]);
  const redisRun = docker(['run', '--detach', '--memory=64m', '--memory-swap=64m', '--name', container, '-p', `127.0.0.1:${port}:6379`, '-v', `${oomVolume}:/data`, 'redis:7-alpine', 'redis-server', '--dir', '/data', '--save', '', '--appendonly', 'yes', '--appendfsync', 'everysec', '--maxmemory', '24mb', '--maxmemory-policy', 'noeviction']);
  assert.ok(redisRun.stdout, 'isolated Redis 7 container started');
  const saturationHostConfig = JSON.parse(docker(['inspect', container, '--format', '{{json .HostConfig}}']).stdout);
  assert.equal(saturationHostConfig.Memory, 64 * 1024 ** 2, 'the Redis integration container receives the bounded cgroup limit');
  assert.equal(saturationHostConfig.MemorySwap, 64 * 1024 ** 2, 'maxmemory/OOM scenarios do not silently use container swap');
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
  await within('BullMQ producer queue readiness', queue.waitUntilReady(), 15_000);
  createGuild(activeGuildId, activeTargetId, { holdKick: true });
  createGuild(pendingGuildId, pendingTargetId);
  const client = { isReady: () => true, guilds: { cache: { get: id => guildMap.get(id) } } };
  worker = createModerationWorker(client, consumerConnection, prisma, moderation, rejectPendingAfterDisable, () => undefined, {
    onGuildBusySkip: (guildId, operationId) => guildBusySkips.push({ guildId, operationId, at: Date.now() }),
  }, queueName, { lockDuration: 12_000, stalledInterval: 500 });
  worker.on('active', job => {
    const scenario = recoveryScenarios.get(job.id);
    if (scenario) scenario.deliveries++;
    if (job.id === oomOperationId) oomQueueDeliveries++;
    if (job.id === activeOperationId) pressureActiveDeliveries++;
  });
  worker.on('stalled', jobId => { const scenario = recoveryScenarios.get(jobId); if (scenario) scenario.stalled++; if (jobId === activeOperationId) pressureActiveStalled++; });
  worker.on('failed', (job, error) => {
    const scenario = recoveryScenarios.get(job?.id);
    const failure = { jobId: job?.id, name: error?.name ?? 'unknown', message: String(error?.message ?? 'unknown').slice(0, 300) };
    workerFailures.push(failure);
    scenario?.failures.push(failure);
    if (job?.id === activeOperationId) pressureActiveFailures++;
  });
  worker.on('completed', job => { const scenario = recoveryScenarios.get(job.id); if (scenario) scenario.completions++; if (job.id === activeOperationId) pressureActiveCompletions++; });
  worker.on('error', error => workerErrors.push({ at: Date.now(), source: 'worker', name: error?.name ?? 'unknown' }));

  let dispatcherQueryCount = 0;
  const dispatchStore = {
    $queryRaw: (...args) => { dispatcherQueryCount++; return prisma.$queryRaw(...args); },
    moderationCase: prisma.moderationCase,
  };
  dispatch = createDispatcher(dispatchStore, queue, () => true, (key, message, error) => {
    dispatchErrors.push({ at: Date.now(), key, message, errorName: error instanceof Error ? error.name : 'unknown', errorMessage: error instanceof Error ? error.message : String(error) });
  }, attempt => dispatchAttempts.push({ at: Date.now(), ...attempt }));
  await until('BullMQ producer connection ready before applying Redis memory pressure', async () => (await queue.getBackend().client).status === 'ready');

  const runRecoveryScenario = async ({ operationId, guildId, targetId, label, outageMs, expectStalled }) => {
    const gate = makeRecoveryGate(operationId);
    await within(`${label}: PostgreSQL guild setup`, prisma.guildConfig.create({ data: { guildId, updatedBy: actorId, memberActionsEnabled: true } }), 10_000);
    createGuild(guildId, targetId, { recovery: gate });
    await createRequest(guildId, targetId, operationId, `Controlled ${label} Redis recovery`);
    await within(`${label}: production dispatcher wake`, dispatch(), 15_000);
    await within(`${label}: production worker enters controlled Discord adapter`, gate.enteredGate, 15_000);
    await until(`${label}: job is active in BullMQ`, async () => {
      const job = await queue.getJob(operationId);
      return job ? await job.getState() === 'active' : false;
    }, 15_000);
    const lockKey = `${queue.toKey(operationId)}:lock`;
    const lockTtlBefore = Number(await rawRedis.command(['PTTL', lockKey]));
    assert.ok(lockTtlBefore > 0, `${label}: BullMQ lock has a live TTL before outage`);
    assert.equal(gate.deliveries, 1, `${label}: exactly one initial worker delivery before outage`);
    assert.equal(gate.mutations, 1, `${label}: exactly one simulated Discord mutation entered before outage`);
    await restartRedisControlled({ holdMs: outageMs, label });
    const lockTtlAfter = Number(await rawRedis.command(['PTTL', lockKey]));
    if (expectStalled) {
      assert.ok(lockTtlAfter < 0, `${label}: the lock is absent after its test-only lease expired (PTTL=${lockTtlAfter})`);
      await within(`${label}: BullMQ reports stalled recovery`, until(`${label}: stalled event and redelivery`, () => gate.stalled >= 1 && gate.deliveries >= 2, 15_000), 16_000);
      // The same worker still owns the original in-flight operation, so its duplicate
      // delivery must be skipped by the production per-guild guard, not mutate Discord.
      assert.equal(gate.mutations, 1, `${label}: stalled delivery did not repeat the mutation`);
      assert.ok(guildBusySkips.some(skip => skip.operationId === operationId && skip.guildId === guildId), `${label}: the live production worker's same-guild guard observed and skipped the stalled redelivery`);
      gate.release();
      await until(`${label}: original operation reaches durable PostgreSQL success`, async () => (await row(operationId))?.status === 'succeeded', 20_000);
    } else {
      assert.ok(lockTtlAfter > 0, `${label}: the original lock remains live before expiry (PTTL=${lockTtlAfter})`);
      gate.release();
      await until(`${label}: operation reaches durable PostgreSQL success`, async () => (await row(operationId))?.status === 'succeeded', 20_000);
    }
    await until(`${label}: BullMQ proof job is removed after completion`, async () => (await queue.getJob(operationId)) === undefined, 20_000);
    assert.equal((await row(operationId)).status, 'succeeded', `${label}: PostgreSQL operation is succeeded`);
    assert.equal(gate.mutations, 1, `${label}: exactly one simulated Discord mutation`);
    assert.equal(gate.failures.length, 0, `${label}: no BullMQ failed event before auto-removal`);
    if (!expectStalled) {
      assert.equal(gate.deliveries, 1, `${label}: no redelivery while lock is valid`);
      assert.equal(gate.stalled, 0, `${label}: no stalled event before lock expiry`);
    } else {
      assert.equal(gate.deliveries, 2, `${label}: one initial delivery plus exactly one stalled redelivery`);
      assert.equal(gate.stalled, 1, `${label}: exactly one stalled recovery was observed`);
      assert.equal(gate.completions, 1, `${label}: exactly one recovered queue job emitted completion`);
    }
    console.info(JSON.stringify({ event: 'bullmq_redis_recovery_scenario', label, deliveries: gate.deliveries, stalledEvents: gate.stalled, mutations: gate.mutations, failures: gate.failures.length, lockTtlBeforeMs: lockTtlBefore, lockTtlAfterRestartMs: lockTtlAfter, outcome: (await row(operationId)).status }));
  };

  // Integration-only lease timings: 12 s lock / 500 ms stalled scan, not the BullMQ
  // production defaults (30 s / 30 s). The outage durations straddle that lease.
  await runRecoveryScenario({ operationId: preExpiryOperationId, guildId: preExpiryGuildId, targetId: preExpiryTargetId, label: 'restart_before_lock_expiry', outageMs: 1_000, expectStalled: false });
  await runRecoveryScenario({ operationId: postExpiryOperationId, guildId: postExpiryGuildId, targetId: postExpiryTargetId, label: 'restart_after_lock_expiry', outageMs: 13_000, expectStalled: true });

  // Start the separate held action after the long stalled-recovery scenario.
  // Otherwise that outage can expire this unrelated job's lease, redeliver it,
  // and remove its Redis keys through the per-guild busy guard while the action
  // is still held. This made the pressure setup depend on background cleanup.
  const queueCountsBeforePressure = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  assert.deepEqual(queueCountsBeforePressure, { waiting: 0, active: 0, delayed: 0, failed: 0 }, 'both earlier restart scenarios are drained before the pressure scenario starts');
  assert.equal(pendingKickCount, 0, 'no prior recovery scenario left work for the worker to consume');
  await createRequest(activeGuildId, activeTargetId, activeOperationId, 'Controlled active action during Redis saturation');
  await within('initial BullMQ job enqueue', queue.add('moderation-action', { guildId: activeGuildId, operationId: activeOperationId }, { jobId: activeOperationId, attempts: 1, removeOnComplete: true, removeOnFail: true }), 15_000);
  await within('initial controlled Discord mutation gate', enteredGate, 15_000);
  assert.equal(activeKickCount, 1, 'the only active worker is held inside the controlled Discord adapter before pressure is applied');
  const queueCountsAfterPressureGate = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  assert.deepEqual(queueCountsAfterPressureGate, { waiting: 0, active: 1, delayed: 0, failed: 0 }, 'the held action remains the sole active job when pressure begins');
  await createRequest(pendingGuildId, pendingTargetId, pendingOperationId, 'Must remain durable while Redis refuses writes');
  expiryMarker = `pressure-marker-${suffix}`;
  await within('due expiry guild setup', prisma.guildConfig.create({ data: { guildId: expiryGuildId, updatedBy: actorId, memberActionsEnabled: true } }), 10_000);
  await within('due expiry case setup', prisma.moderationCase.create({ data: {
    id: expiryCaseId, operationId: expiryOperationId, guildId: expiryGuildId, actorId, targetId: expiryTargetId,
    action: 'TEMPBAN', reason: 'Due expiry retained through Redis outage', status: 'succeeded', durationMinutes: 1,
    expiresAt: new Date(Date.now() - 60_000), banMarker: expiryMarker, banGeneration: 1, expiryStatus: 'scheduled',
  } }), 10_000);
  await within('due expiry decision setup', prisma.guildTargetDecision.create({ data: {
    guildId: expiryGuildId, targetId: expiryTargetId, generation: 1, latestOperationId: expiryOperationId,
    appliedGeneration: 1, appliedOperationId: expiryOperationId,
  } }), 10_000);
  createGuild(expiryGuildId, expiryTargetId, { banReason: `temporary ban [${expiryMarker}]` });

  // Complete Redis/BullMQ reads before saturating. The job must be active and
  // its lock live before pressure starts; reads after the final fill could run
  // BullMQ's own housekeeping at the exact boundary this test is measuring.
  const heldJobBeforeFill = await queue.getJob(activeOperationId);
  assert.equal(await heldJobBeforeFill?.getState(), 'active', 'the controlled in-flight job is active before Redis is filled');
  const lockTtlBeforeFill = Number(await rawRedis.command(['PTTL', `${queue.toKey(activeOperationId)}:lock`]));
  assert.ok(lockTtlBeforeFill > 0, `the controlled in-flight BullMQ lock is live before filling (PTTL=${lockTtlBeforeFill})`);
  assert.equal(activeKickCount, 1, 'the controlled Discord adapter remains in flight before Redis is filled');
  const producer = await queue.getBackend().client;
  assert.equal(producer.status, 'ready', 'the production BullMQ producer is connected before the OOM publication attempt');

  await logRedisPressureSnapshot('before_fill');
  const filler = 'x'.repeat(1024 * 1024);
  let pressureFillRefusals = 0;
  let largeChunkRejected = false;
  for (let i = 0; i < 40; i++) {
    const key = `pressure:filler:${i}`;
    try { await rawRedis.command(['SET', key, filler]); fillerKeys.push(key); }
    catch (error) {
      assert.match(error.message, /^OOM /, 'Redis refused a write because maxmemory was reached');
      pressureFillRefusals++;
      largeChunkRejected = true;
      break;
    }
  }
  assert.ok(largeChunkRejected, 'a 1 MiB write proves the isolated Redis 7 instance reached noeviction maxmemory');
  await logRedisPressureSnapshot('after_megabyte_fill');
  let smallChunkRejected = false;
  let fillerIndex = 40;
  // Refine the remaining headroom geometrically. The old 1 KiB loop could
  // issue thousands of round trips, leaving a long window for background Redis
  // key cleanup to change the free-memory boundary between the refusal probe
  // and BullMQ publication. Small bounded stages keep that interval short; the
  // explicit pre-publication probe and operation-attempt assertion make any
  // remaining race fail as a synchronization error rather than pass silently.
  for (const chunkSize of [64 * 1024, 4 * 1024, 256, 16, 1]) {
    const smallFiller = 'x'.repeat(chunkSize);
    let rejectedThisStage = false;
    for (let attempt = 0; attempt < 64; attempt++, fillerIndex++) {
      const key = `pressure:filler:${fillerIndex}`;
      try { await rawRedis.command(['SET', key, smallFiller]); fillerKeys.push(key); }
      catch (error) {
        assert.match(error.message, /^OOM /, 'Redis rejects progressively smaller writes because maxmemory/noeviction is active');
        pressureFillRefusals++;
        rejectedThisStage = true;
        break;
      }
    }
    if (rejectedThisStage && chunkSize === 1) {
      smallChunkRejected = true;
      break;
    }
  }
  assert.ok(smallChunkRejected, 'a one-byte payload is refused at the final maxmemory boundary');
  await logRedisPressureSnapshot('after_fill_refusal');

  // A rejected one-byte SET only establishes a boundary condition. Keep all
  // filler keys, then lower the isolated noeviction ceiling to a measured
  // preparation target: 4 MiB required minimum + 8 MiB reserve. This avoids
  // placing the later BullMQ write at the exact threshold while keeping enough
  // headroom for the observations made around normal client-buffer variation.
  const originalMemoryInfo = await rawRedis.command(['INFO', 'memory']);
  const originalMaxMemory = Number(originalMemoryInfo.match(/^maxmemory:(\d+)/m)?.[1]);
  assert.equal(originalMaxMemory, 24 * 1024 * 1024, 'the saturation phase starts with its documented 24 MiB noeviction ceiling');
  const usedMemoryBeforeAdjustment = Number(originalMemoryInfo.match(/^used_memory:(\d+)/m)?.[1]);
  let pressureMaxMemoryObserved = originalMaxMemory;
  let pressureUsedMemoryAtCeiling = usedMemoryBeforeAdjustment;
  let pressureMarginBytesAtCeiling = pressureUsedMemoryAtCeiling - pressureMaxMemoryObserved;
  const pressureAdjustmentLog = [];
  await logRedisPressureSnapshot('before_pressure_ceiling_adjustment');
  for (let adjustment = 1; adjustment <= maximumPressureAdjustments; adjustment++) {
    if (pressureMarginBytesAtCeiling >= pressurePreparationTargetBytes) break;
    const requestedMaxMemory = Math.max(minimumPressureMaxMemoryBytes, pressureUsedMemoryAtCeiling - pressurePreparationTargetBytes);
    assert.ok(requestedMaxMemory < pressureMaxMemoryObserved, `bounded pressure adjustment ${adjustment} lowers the isolated noeviction ceiling`);
    assert.equal(await rawRedis.command(['CONFIG', 'SET', 'maxmemory', `${requestedMaxMemory}`]), 'OK', `isolated Redis accepts bounded pressure adjustment ${adjustment}`);
    const adjustmentInfo = await rawRedis.command(['INFO', 'memory']);
    pressureUsedMemoryAtCeiling = Number(adjustmentInfo.match(/^used_memory:(\d+)/m)?.[1]);
    pressureMaxMemoryObserved = Number(adjustmentInfo.match(/^maxmemory:(\d+)/m)?.[1]);
    pressureMarginBytesAtCeiling = pressureUsedMemoryAtCeiling - pressureMaxMemoryObserved;
    pressureAdjustmentLog.push({ adjustment, requestedMaxMemoryBytes: requestedMaxMemory, usedMemoryBytes: pressureUsedMemoryAtCeiling, observedMaxMemoryBytes: pressureMaxMemoryObserved, observedMarginBytes: pressureMarginBytesAtCeiling });
    await logRedisPressureSnapshot(`pressure_ceiling_adjustment_${adjustment}`);
  }
  assert.ok(pressureMarginBytesAtCeiling >= pressurePreparationTargetBytes,
    `bounded pressure preparation reaches target margin ${pressurePreparationTargetBytes} bytes (minimum ${minimumPressureMarginBytes}, reserve ${pressurePreparationReserveBytes}, observed ${pressureMarginBytesAtCeiling}; adjustments ${JSON.stringify(pressureAdjustmentLog)})`);
  assert.ok(pressureMaxMemoryObserved >= minimumPressureMaxMemoryBytes, `isolated pressure ceiling remains above its explicit floor (${pressureMaxMemoryObserved} bytes)`);
  console.info(JSON.stringify({ event: 'redis_pressure_prepared', minimumMarginBytes: minimumPressureMarginBytes, preparationTargetMarginBytes: pressurePreparationTargetBytes, reserveBytes: pressurePreparationReserveBytes, adjustmentCount: pressureAdjustmentLog.length, adjustments: pressureAdjustmentLog, usedMemoryBytes: pressureUsedMemoryAtCeiling, maxMemoryBytes: pressureMaxMemoryObserved, observedMarginBytes: pressureMarginBytesAtCeiling }));
  const pressureProbeStartedAt = Date.now();
  await logRedisPressureSnapshot('immediately_before_publish_probe');
  const activeJobAtPressure = await queue.getJob(activeOperationId);
  assert.equal(await activeJobAtPressure?.getState(), 'active', 'the original controlled job remains active at the pressure boundary');
  const lockTtlImmediatelyBeforeDispatch = Number(await rawRedis.command(['PTTL', `${queue.toKey(activeOperationId)}:lock`]));
  assert.ok(lockTtlImmediatelyBeforeDispatch > 0, `the original active BullMQ lock remains live before dispatch (PTTL=${lockTtlImmediatelyBeforeDispatch})`);
  assert.equal(pressureActiveDeliveries, 1, 'no stalled redelivery occurred while memory was saturated');
  assert.equal(pressureActiveStalled, 0, 'the active pressure job was not marked stalled');
  assert.equal(pressureActiveCompletions, 0, 'the active pressure job was not completed and removed during saturation');
  assert.equal(pressureActiveFailures, 0, 'the active pressure job did not fail during saturation');
  assert.equal(activeKickCount, 1, 'the first simulated Discord mutation is still held while dispatch is attempted');
  let preDispatchProbeError;
  try { await rawRedis.command(['SET', `pressure:pre-dispatch-probe:${suffix}`, 'x']); }
  catch (error) { preDispatchProbeError = error; }
  const preDispatchProbeRefused = Boolean(preDispatchProbeError);
  await logRedisPressureSnapshot(preDispatchProbeError ? 'after_rejected_publish_probe' : 'after_accepted_publish_probe');
  assert.match(preDispatchProbeError?.message ?? '', /^OOM /, 'Redis still refuses a fresh write immediately before invoking the dispatcher');
  const probeMemoryInfo = await rawRedis.command(['INFO', 'memory']);
  const probeMarginBytes = Number(probeMemoryInfo.match(/^used_memory:(\d+)/m)?.[1]) - Number(probeMemoryInfo.match(/^maxmemory:(\d+)/m)?.[1]);
  assert.ok(probeMarginBytes >= minimumPressureMarginBytes, `the fresh-write probe occurs with the required minimum ${minimumPressureMarginBytes}-byte margin (${probeMarginBytes} bytes; preparation target ${pressurePreparationTargetBytes})`);
  const attemptsBeforeRefusedPublish = dispatchAttempts.length;
  const dispatchPromise = dispatch();
  await within('production dispatcher wake before maxmemory refusal', dispatchPromise, 15_000);
  const refusedPublishAttempt = dispatchAttempts.slice(attemptsBeforeRefusedPublish).find(attempt => attempt.operationId === pendingOperationId && attempt.kind === 'action');
  assert.ok(refusedPublishAttempt, 'the production dispatcher selected the durable PostgreSQL request and entered BullMQ publication');
  assert.ok(refusedPublishAttempt.queueAddStartedAt >= pressureProbeStartedAt, 'the selected request reached queue.add after the Redis OOM probes');
  await until('diagnostic emitted after the selected BullMQ publication attempt settled', () => dispatchErrors.some(error => error.at >= refusedPublishAttempt.queueAddStartedAt), 5_000);
  const refusedPublishDiagnostics = dispatchErrors.filter(error => error.at >= refusedPublishAttempt.queueAddStartedAt);
  assert.equal(refusedPublishDiagnostics.length, 1, 'a refused publish is diagnosed once after the dispatcher attempt completes');
  assert.equal(refusedPublishDiagnostics[0].key, 'moderation-queue-dispatch');
  assert.match(refusedPublishDiagnostics[0].message, /PostgreSQL request remains durable/);
  assert.match(refusedPublishDiagnostics[0].errorName, /Error/);
  assert.match(refusedPublishDiagnostics[0].errorMessage, /^OOM /, 'BullMQ publication failed with Redis maxmemory OOM, not a connection failure');
  const dispatcherCooldownStartedAt = refusedPublishDiagnostics[0].at;
  const publishErrorInfo = await rawRedis.command(['INFO', 'memory']);
  const publishErrorUsedMemory = Number(publishErrorInfo.match(/^used_memory:(\d+)/m)?.[1]);
  const publishErrorMaxMemory = Number(publishErrorInfo.match(/^maxmemory:(\d+)/m)?.[1]);
  const publishErrorMarginBytes = publishErrorUsedMemory - publishErrorMaxMemory;
  assert.ok(publishErrorMarginBytes >= minimumPressureMarginBytes, `the BullMQ OOM occurred with the required minimum ${minimumPressureMarginBytes}-byte margin (${publishErrorMarginBytes} bytes; preparation target ${pressurePreparationTargetBytes})`);
  assert.equal(await rawRedis.command(['CONFIG', 'SET', 'maxmemory', `${originalMaxMemory}`]), 'OK', 'restore the initial isolated Redis ceiling after the expected publication refusal');
  assert.equal((await row(pendingOperationId)).status, 'requested', 'failed Redis enqueue does not lose accepted PostgreSQL work');
  assert.equal((await within('read due expiry after refused publication', prisma.moderationCase.findUnique({ where: { id: expiryCaseId } }), 10_000)).expiryStatus, 'scheduled', 'due expiry remains durable');
  assert.equal(activeKickCount, 1, 'the already active controlled Discord operation was not repeated');

  const outboxQueriesBeforeCooldownWakes = dispatcherQueryCount;
  const errorsBeforeCooldownWakes = dispatchErrors.length;
  for (let i = 0; i < 8; i++) await within(`dispatcher cooldown wake ${i + 1}`, dispatch(), 5_000);
  const dispatcherOutboxQueriesDuringCooldown = dispatcherQueryCount - outboxQueriesBeforeCooldownWakes;
  const dispatcherErrorsDuringBackoff = dispatchErrors.length - errorsBeforeCooldownWakes;
  assert.equal(dispatchErrors.length, 1, 'repeated wakes are held by exponential cooldown rather than log/retry storm');
  assert.equal(dispatcherOutboxQueriesDuringCooldown, 0, 'cooldown avoids repeated PostgreSQL outbox scans');
  assert.equal(dispatcherErrorsDuringBackoff, 0, 'cooldown emits no additional diagnostics');

  kickRelease();
  await until('active action durable completion while Redis is saturated', async () => (await row(activeOperationId))?.status === 'succeeded');
  await clearFillerKeys();
  // Anchor the wait to the observed refused-publication diagnostic. Starting
  // it before dispatch begins can wake slightly before redisRetryAt and then
  // leave the durable request idle because this test deliberately has no timer.
  const retryDeadlineAt = dispatcherCooldownStartedAt + 1_000;
  const remainingBackoff = Math.max(0, retryDeadlineAt - Date.now());
  if (remainingBackoff) await within('bounded dispatcher cooldown expiry', delay(remainingBackoff), 1_500);
  const recoveryAttemptsBefore = dispatchAttempts.length;
  await until('production dispatcher publishes after observed cooldown and Redis recovery', async () => {
    await within('dispatcher recovery poll', dispatch(), 5_000);
    return dispatchAttempts.slice(recoveryAttemptsBefore).some(attempt => attempt.operationId === pendingOperationId && attempt.kind === 'action' && attempt.queueAddStartedAt >= retryDeadlineAt);
  }, 10_000);

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
  assert.equal((await within('read due expiry after recovery', prisma.moderationCase.findUnique({ where: { id: expiryCaseId } }), 10_000)).expiryStatus, 'succeeded');
  assert.equal(activeKickCount, 1, 'lost/late BullMQ acknowledgement cannot produce a second Discord mutation');
  assert.equal(pendingKickCount, 1, 'the durable request is executed once after recovery');
  assert.equal(unbanCount, 1, 'the overdue expiry is reconciled once after Redis recovers');
  await within('production dispatcher reconciliation after recovery', dispatch(), 15_000);
  assert.equal(activeKickCount + pendingKickCount, 2, 'a later reconciliation does not repeat completed actions');
  assert.equal(unbanCount, 1, 'a later reconciliation does not repeat a completed expiry');

  // Separate cgroup OOM test: disable Redis maxmemory only after the maxmemory refusal assertions above.
  // PostgreSQL remains the durable outbox while Redis itself is killed under a bounded 64 MiB cgroup.
  await within('OOM test guild setup', prisma.guildConfig.createMany({ data: [oomPendingGuildId, oomExpiryGuildId].map(guildId => ({ guildId, updatedBy: actorId, memberActionsEnabled: true })) }), 10_000);
  createGuild(activeGuildId, activeTargetId, { oomHoldKick: true });
  createGuild(oomPendingGuildId, oomPendingTargetId);
  createGuild(oomExpiryGuildId, oomExpiryTargetId, { banReason: `temporary ban [pressure-oom-marker-${suffix}]` });
  assert.equal(await rawRedis.command(['CONFIG', 'SET', 'appendfsync', 'always']), 'OK');
  await createRequest(activeGuildId, activeTargetId, oomOperationId, 'Controlled mutation in flight during Redis cgroup OOM');
  const oomExpiryMarker = `pressure-oom-marker-${suffix}`;
  await within('production dispatcher wake before OOM', dispatch(), 15_000);
  await until('controlled Discord adapter entered during OOM scenario', () => oomKickWasEntered, 15_000);
  await until('active BullMQ job exists before Redis outage', async () => {
    const activeJob = await queue.getJob(oomOperationId);
    return activeJob ? await activeJob.getState() === 'active' : false;
  });
  assert.equal(oomQueueDeliveries, 1, 'the controlled operation had exactly one initial production-worker delivery before OOM');
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
  console.info(JSON.stringify({ event: 'redis_cgroup_oom_confirmed', containerLimitBytes: 64 * 1024 ** 2 }));
  const oomState = JSON.parse(docker(['inspect', container, '--format', '{{json .State}}']).stdout);
  assert.equal(oomState.OOMKilled, true, 'Docker confirms the Redis process was cgroup OOM-killed');
  const outageStartedAt = Date.now();
  const queueClientBeforeRestart = await queue.getBackend().client;
  const workerClientBeforeRestart = await worker.getBackend().client;
  await until('same BullMQ clients detect Redis outage', () => queueClientBeforeRestart.status !== 'ready' && workerClientBeforeRestart.status !== 'ready', 5_000);
  await createRequest(oomPendingGuildId, oomPendingTargetId, oomPendingOperationId, 'Durable while Redis is OOM-killed');
  await within('OOM due expiry case setup', prisma.moderationCase.create({ data: {
    id: oomExpiryCaseId, operationId: oomExpiryOperationId, guildId: oomExpiryGuildId, actorId, targetId: oomExpiryTargetId,
    action: 'TEMPBAN', reason: 'Due expiry retained through Redis cgroup OOM', status: 'succeeded', durationMinutes: 1,
    expiresAt: new Date(Date.now() - 60_000), banMarker: oomExpiryMarker, banGeneration: 1, expiryStatus: 'scheduled',
  } }), 10_000);
  await within('OOM due expiry decision setup', prisma.guildTargetDecision.create({ data: {
    guildId: oomExpiryGuildId, targetId: oomExpiryTargetId, generation: 1, latestOperationId: oomExpiryOperationId,
    appliedGeneration: 1, appliedOperationId: oomExpiryOperationId,
  } }), 10_000);
  assert.equal((await row(oomPendingOperationId)).status, 'requested', 'PostgreSQL retains the pending accepted operation across Redis OOM');
  assert.equal((await within('read OOM due expiry before Redis returns', prisma.moderationCase.findUnique({ where: { id: oomExpiryCaseId } }), 10_000)).expiryStatus, 'scheduled', 'PostgreSQL retains the due expiry across Redis OOM');
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
    await until('active BullMQ job is completed or recovered after Redis restart and queue drains', async () => {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      return Object.values(counts).every(count => count === 0);
    }, 90_000);
  } finally {
    clearInterval(recoveryTimer);
  }
  assert.ok([1, 2].includes(oomQueueDeliveries), `OOM recovery observed one initial delivery and at most one stalled redelivery (observed ${oomQueueDeliveries})`);
  assert.ok(dispatchAttempts.some(attempt => attempt.operationId === oomPendingOperationId), 'the same production dispatcher published the durable pending request');
  assert.ok(dispatchAttempts.some(attempt => attempt.operationId === `expiry-${oomExpiryCaseId}`), 'the same production dispatcher published the due PostgreSQL expiry');
  const outageEnqueueAttempts = dispatchAttempts.filter(attempt => attempt.at >= outageStartedAt).length;
  assert.ok(outageEnqueueAttempts <= 4, `outage/recovery publication attempts remain bounded (observed ${outageEnqueueAttempts})`);
  assert.ok(workerErrors.length + queueErrors.length - outageErrorCountBeforeRestart <= 20, 'client disconnect/reconnect diagnostics are bounded');
  assert.ok(dispatchErrors.filter(error => error.at >= outageStartedAt).length <= 4, 'dispatcher retry diagnostics remain bounded during the Redis outage');
  assert.equal((await row(oomOperationId)).status, 'succeeded');
  assert.equal((await row(oomPendingOperationId)).status, 'succeeded');
  assert.equal((await within('read OOM due expiry after recovery', prisma.moderationCase.findUnique({ where: { id: oomExpiryCaseId } }), 10_000)).expiryStatus, 'succeeded');
  assert.equal(oomKickCount, 1, 'redelivery after cgroup OOM cannot repeat a confirmed mutation');
  const oomFailureEvents = workerFailures.filter(failure => failure.jobId === oomOperationId);
  assert.equal(oomFailureEvents.length, 0, 'no OOM scenario job failure was emitted before removeOnFail could remove a job');
  console.info(JSON.stringify({ event: 'bullmq_oom_recovery_path', deliveries: oomQueueDeliveries, path: oomQueueDeliveries === 1 ? 'active_job_completed_without_stall' : 'active_job_recovered_after_stall', failuresObservedBeforeRemoval: oomFailureEvents.length }));
  assert.equal(pendingKickCount, 2, 'durable pending operations execute exactly once after recovery');
  assert.equal(unbanCount, 2, 'due expiry is reconciled exactly once after recovery');
  const memoryInfo = await rawRedis.command(['INFO', 'memory']);
  const usedMemoryBytes = Number(memoryInfo.match(/used_memory:(\d+)/)?.[1]);
  const maxMemoryBytes = Number(memoryInfo.match(/maxmemory:(\d+)/)?.[1]);
  console.info(JSON.stringify({
    event: 'redis_saturation_integration_passed', elapsedMs: Date.now() - testStartedAt, redisVersion,
    pressureFillRefusals, preDispatchProbeRefused, bullMqPublishRefused: true,
    pressureUsedMemoryBytesAtCeiling: pressureUsedMemoryAtCeiling, pressureMaxMemoryBytes: pressureMaxMemoryObserved,
    pressureMarginBytesAtCeiling, pressurePreparationTargetBytes, pressurePreparationReserveBytes, minimumPressureMarginBytes, pressureAdjustmentCount: pressureAdjustmentLog.length, pressureUsedMemoryBytesAtPublishError: publishErrorUsedMemory, pressureMarginBytesAtPublishError: publishErrorMarginBytes,
    usedMemoryBytes, maxMemoryBytes,
    acceptedRows: 2, backpressureAndOomActions: activeKickCount + pendingKickCount, controlledRecoveryMutations: [...recoveryScenarios.values()].reduce((total, scenario) => total + scenario.mutations, 0) + oomKickCount, expiriesAfterRecovery: unbanCount,
    dispatcherErrors: dispatchErrors.length, dispatcherOutboxQueriesDuringCooldown, dispatcherErrorsDuringBackoff,
    workerRedisErrors: workerErrors.length, queueRedisErrors: queueErrors.length, oomQueueDeliveries,
    workerFailureEventsBeforeRemoval: workerFailures.length,
    recoveryScenarios: [...recoveryScenarios.values()].map(({ operationId, deliveries, stalled, mutations, failures, completions }) => ({ operationId, deliveries, stalled, mutations, failures: failures.length, completions })),
    cgroupOom: { containerLimitBytes: 64 * 1024 ** 2, oomKilled: oomState.OOMKilled, exitCode: oomState.ExitCode, oomWriterStopped: oomWriterStatus === 1, inFlightMutations: oomKickCount, pendingRowsRecovered: 1, expiriesRecovered: 1, duplicateMutations: false, aofVolume: 'isolated; Redis 7 appendonly everysec' },
  }));
} finally {
  kickRelease?.();
  oomKickRelease?.();
  for (const scenario of recoveryScenarios.values()) scenario.release();
  if (rawRedis && fillerKeys.length) await clearFillerKeys();
  if (worker) await within('worker shutdown cleanup', worker.close(true), 5_000).catch(() => undefined);
  if (queue) await within('queue shutdown cleanup', queue.close(), 5_000).catch(() => undefined);
  rawRedis?.close();
  docker(['rm', '-f', container], true);
  if (oomVolume) docker(['volume', 'rm', '-f', oomVolume], true);
  await within('test operation cleanup', prisma.moderationCase.deleteMany({ where: { OR: [{ operationId: { in: [activeOperationId, pendingOperationId, expiryOperationId, oomOperationId, oomPendingOperationId, oomExpiryOperationId, preExpiryOperationId, postExpiryOperationId] } }, { id: { in: [expiryCaseId, oomExpiryCaseId] } }] } }), 8_000).catch(() => undefined);
  await within('test decision cleanup', prisma.guildTargetDecision.deleteMany({ where: { guildId: { in: [activeGuildId, pendingGuildId, expiryGuildId, oomPendingGuildId, oomExpiryGuildId, preExpiryGuildId, postExpiryGuildId] } } }), 8_000).catch(() => undefined);
  await within('test guild cleanup', prisma.guildConfig.deleteMany({ where: { guildId: { in: [activeGuildId, pendingGuildId, expiryGuildId, oomPendingGuildId, oomExpiryGuildId, preExpiryGuildId, postExpiryGuildId] } } }), 8_000).catch(() => undefined);
  await within('Prisma disconnect cleanup', prisma.$disconnect(), 5_000).catch(() => undefined);
}
