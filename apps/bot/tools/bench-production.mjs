import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { prisma, postgresPool, takeAdmissionMetrics, takePoolAcquireMetrics, withModerationAdmission } from '@veyrobot/db';
import { redisConnection, submitModerationAction } from '@veyrobot/moderation';
import { createDispatcher } from '../dist/dispatcher.js';
import { createModerationWorker } from '../dist/worker.js';

const seconds = Number(process.env.BENCH_SECONDS ?? 1800);
const phaseSeconds = Number(process.env.BENCH_PHASE_SECONDS ?? 300);
const idleSeconds = Number(process.env.BENCH_IDLE_SECONDS ?? 300);
const quietGuilds = Number(process.env.BENCH_QUIET_GUILDS ?? 100);
const dominantGuildCount = Number(process.env.BENCH_DOMINANT_GUILDS ?? 3);
const normalRps = Number(process.env.BENCH_NORMAL_RPS ?? 2);
const dominantRps = Number(process.env.BENCH_DOMINANT_RPS ?? 8);
const burstRps = Number(process.env.BENCH_BURST_RPS ?? 20);
const burstSeconds = Number(process.env.BENCH_BURST_SECONDS ?? 10);
const expiryPerMinute = Number(process.env.BENCH_EXPIRIES_PER_MINUTE ?? 6);
const discordDelayMs = Number(process.env.BENCH_DISCORD_DELAY_MS ?? 150);
const sampleSeconds = Number(process.env.BENCH_SAMPLE_SECONDS ?? 5);
const progressSeconds = Number(process.env.BENCH_PROGRESS_SECONDS ?? 60);
const drainTimeoutMs = Number(process.env.BENCH_DRAIN_TIMEOUT_MS ?? 300_000);
const dispatcherIntervalMs = Number(process.env.BENCH_DISPATCH_INTERVAL_MS ?? 1_000);
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const prefix = `bench_${runId}_`;
const queueName = 'veyrobot-moderation';
const env = process.env;
if (![seconds, phaseSeconds, idleSeconds, quietGuilds, dominantGuildCount, normalRps, dominantRps, burstRps, burstSeconds, expiryPerMinute, discordDelayMs, sampleSeconds, progressSeconds, drainTimeoutMs, dispatcherIntervalMs].every(Number.isFinite) || seconds < 30 || seconds > 86_400 || phaseSeconds < 30 || idleSeconds < 0 || quietGuilds < 2 || quietGuilds > 2_000 || dominantGuildCount < 1 || dominantGuildCount > 8 || quietGuilds + dominantGuildCount > 2_000 || normalRps < 0.1 || normalRps > 100 || dominantRps < 0.1 || dominantRps > 100 || burstRps < 0.1 || burstRps > 200 || burstSeconds < 1 || burstSeconds > 60 || expiryPerMinute < 0 || expiryPerMinute > 60 || discordDelayMs < 0 || discordDelayMs > 5_000 || sampleSeconds < 1 || sampleSeconds > 60 || progressSeconds < 0 || dispatcherIntervalMs < 100 || dispatcherIntervalMs > 60_000) throw new Error('Invalid benchmark parameters.');
if (seconds < 1800 && env.BENCH_ALLOW_SHORT !== '1') throw new Error('A decision campaign must run at least 1800s. Use BENCH_ALLOW_SHORT=1 only for a harness smoke test.');
if (!env.DATABASE_URL?.includes('veyrobot_foundation_bench')) throw new Error('Use the isolated veyrobot_foundation_bench database.');
const redisDb = env.REDIS_URL ? new URL(env.REDIS_URL).pathname : '';
if (!/^\/(?:[1-9]|1[0-5])$/.test(redisDb)) throw new Error('Use a dedicated nonzero Redis logical database (1–15) for the benchmark.');

const guildIds = Array.from({ length: quietGuilds + dominantGuildCount }, (_, index) => String(200_000_000_000_000_000n + BigInt(index)));
const dominantGuildIds = guildIds.slice(0, dominantGuildCount);
let nextDominantGuild = 0;
const actorId = '123456789012345679';
const counters = { offered: 0, accepted: 0, refused: 0, admissionErrors: 0, arrivalsDelayed: 0, completed: 0, failed: 0, uncertain: 0, expired: 0, expiryUncertain: 0, expiryFailed: 0, discordActionCalls: 0, discordExpiryCalls: 0, dispatchErrors: 0 };
const enqueueAttemptTimes = new Map();
const attemptStartTimes = new Map();
const latency = { quietAdmission: [], dominantAdmission: [], quietDispatcherElapsed: [], quietSerializationWait: [], quietQueueWait: [], quietAcceptToStart: [], quietExecution: [], quietAcceptToFinish: [], dominantDispatcherElapsed: [], dominantSerializationWait: [], dominantQueueWait: [], dominantAcceptToStart: [], dominantExecution: [], dominantAcceptToFinish: [], expiryAgeToStart: [], expirySerializationWait: [], expiryExecution: [], expiryDueToFinish: [] };
const lastGuildFinishAt = new Map();
let busyGuildSkips = 0;
const samples = [];
const lockWindows = [];
const poolWindows = [];
const loop = monitorEventLoopDelay({ resolution: 10 });
let dispatchTimer;
let campaignSampleTimer;
let expiryTimer;
let worker;
let queue;
let mockClient;
let dispatch;
let activeLoad = false;
let pendingAdmission = 0;
let latestSamplePending = 0;
const stats = { rssBytes: [], heapUsedBytes: [], externalBytes: [], eventLoopP95Ms: [], waitingJobs: [], activeJobs: [], delayedJobs: [], oldestRequestedMs: [], oldestExpiryMs: [], poolTotal: [], poolIdle: [], poolWaiting: [] };
let lastProgressBucket = -1;

const role = { comparePositionTo: () => 1 };
const permissions = { bitfield: (1n << 1n) | (1n << 2n) | (1n << 3n), has: () => true };
const adapterCalls = { action: async () => { counters.discordActionCalls++; if (discordDelayMs) await sleep(discordDelayMs); }, expiry: async () => { counters.discordExpiryCalls++; if (discordDelayMs) await sleep(discordDelayMs); } };
function makeGuild(guildId) {
  const member = userId => ({ id: userId, permissions, roles: { highest: role }, kick: adapterCalls.action, timeout: adapterCalls.action, ban: adapterCalls.action });
  return {
    id: guildId, ownerId: actorId,
    members: {
      fetch: async input => member(typeof input === 'string' ? input : input.user),
      fetchMe: async () => member('999999999999999999'),
      unban: adapterCalls.expiry,
    },
    bans: { fetch: async input => {
      const targetId = typeof input === 'string' ? input : input.user;
      const row = await prisma.moderationCase.findFirst({ where: { guildId, targetId, action: 'TEMPBAN', status: 'succeeded' }, orderBy: { createdAt: 'desc' }, select: { banMarker: true } });
      return { reason: row?.banMarker ? `automated [${row.banMarker}]` : null };
    } },
  };
}
const guildMap = new Map(guildIds.map(guildId => [guildId, makeGuild(guildId)]));
mockClient = {
  isReady: () => true,
  guilds: { cache: guildMap, fetch: async id => guildMap.get(id) },
};
const quantile = (list, p) => { const sorted = [...list].sort((a, b) => a - b); return +(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0).toFixed(2); };
const summary = list => ({ count: list.length, p50: quantile(list, .5), p95: quantile(list, .95), p99: quantile(list, .99), max: +(Math.max(0, ...list)).toFixed(2) });
const elapsedSlopePerMinute = (rows, key) => {
  if (rows.length < 2) return null;
  const origin = rows[0].elapsedSeconds;
  const xs = rows.map(row => row.elapsedSeconds - origin), ys = rows.map(row => row[key]);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length, yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  return denominator ? +((xs.reduce((sum, x, i) => sum + (x - xMean) * (ys[i] - yMean), 0) / denominator) * 60).toFixed(2) : 0;
};
function recordEnqueueAttempt(event) {
  const prior = enqueueAttemptTimes.get(event.operationId);
  enqueueAttemptTimes.set(event.operationId, { last: event.queueAddStartedAt, count: (prior?.count ?? 0) + 1 });
}
function recordAttemptStarted(attempt) {
  const enqueueAttempt = enqueueAttemptTimes.get(attempt.operationId);
  if (!enqueueAttempt && attempt.kind !== 'expiry') return;
  const startedAt = Date.now();
  const previousFinishAt = lastGuildFinishAt.get(attempt.guildId) ?? attempt.createdAt.getTime();
  const enqueueStartedAt = enqueueAttempt?.last;
  if (attempt.kind === 'expiry') {
    const dueAt = attempt.scheduledAt?.getTime() ?? attempt.createdAt.getTime();
    latency.expirySerializationWait.push(Math.max(0, previousFinishAt - dueAt));
    latency.expiryAgeToStart.push(Math.max(0, startedAt - dueAt));
    attemptStartTimes.set(attempt.operationId, { startedAt: performance.now(), referenceAt: dueAt, kind: 'expiry' });
  } else {
    const category = dominantGuildIds.includes(attempt.guildId) ? 'dominant' : 'quiet';
    if (enqueueStartedAt) {
      latency[`${category}DispatcherElapsed`].push(Math.max(0, enqueueStartedAt - Math.max(attempt.createdAt.getTime(), previousFinishAt)));
      latency[`${category}QueueWait`].push(Math.max(0, startedAt - Math.max(enqueueStartedAt, previousFinishAt)));
    }
    latency[`${category}SerializationWait`].push(Math.max(0, previousFinishAt - attempt.createdAt.getTime()));
    latency[`${category}AcceptToStart`].push(Math.max(0, startedAt - attempt.createdAt.getTime()));
    attemptStartTimes.set(attempt.operationId, { startedAt: performance.now(), referenceAt: attempt.createdAt.getTime(), kind: category });
  }
  enqueueAttemptTimes.delete(attempt.operationId);
}
function recordAttemptFinished(guildId, operationId) {
  const attempt = attemptStartTimes.get(operationId);
  if (!attempt) return;
  const endedAt = Date.now();
  const executionMs = performance.now() - attempt.startedAt;
  if (attempt.kind === 'expiry') {
    latency.expiryExecution.push(executionMs);
    latency.expiryDueToFinish.push(Math.max(0, endedAt - attempt.referenceAt));
  } else {
    latency[`${attempt.kind}Execution`].push(executionMs);
    latency[`${attempt.kind}AcceptToFinish`].push(Math.max(0, endedAt - attempt.referenceAt));
  }
  attemptStartTimes.delete(operationId);
  lastGuildFinishAt.set(guildId, endedAt);
}
function chooseProfile(elapsedSeconds) {
  const phase = Math.floor(elapsedSeconds / phaseSeconds) % 4;
  const minuteSeconds = elapsedSeconds % 60;
  const quietGuild = () => guildIds[dominantGuildCount + (counters.offered % quietGuilds)];
  const dominantGuild = () => dominantGuildIds[nextDominantGuild++ % dominantGuildCount];
  if (phase === 0) return { name: 'normal', rps: normalRps, guild: quietGuild };
  if (phase === 1) return { name: 'dominant', rps: dominantRps, guild: () => counters.offered % 5 === 0 ? quietGuild() : dominantGuild() };
  if (phase === 2 && minuteSeconds < burstSeconds) return { name: 'burst', rps: burstRps, guild: () => counters.offered % 10 === 0 ? quietGuild() : dominantGuild() };
  if (phase === 2) return { name: 'normal', rps: normalRps, guild: quietGuild };
  return { name: 'mixed', rps: normalRps + dominantRps / 2, guild: () => counters.offered % 3 === 0 ? quietGuild() : dominantGuild() };
}

async function admitAction(category, guildId) {
  const operationId = `${prefix}${category}_${String(counters.offered).padStart(8, '0')}`;
  const targetId = String(300_000_000_000_000_000n + BigInt(counters.offered));
  const data = { ...{ operationId }, guildId, actorId, targetId, action: 'KICK', reason: 'isolated production worker benchmark' };
  counters.offered++;
  const receivedAt = performance.now();
  pendingAdmission++;
  try {
    await withModerationAdmission(prisma, guildId, operationId, tx => submitModerationAction(tx, data));
    counters.accepted++;
    latency[`${dominantGuildIds.includes(guildId) ? 'dominant' : 'quiet'}Admission`].push(performance.now() - receivedAt);
  } catch (error) {
    if (error?.code === 'MODERATION_BACKLOG_LIMIT') counters.refused++;
    else { counters.admissionErrors++; throw error; }
  } finally { pendingAdmission--; }
}
async function createExpiry() {
  const sequence = counters.expired + counters.expiryUncertain + counters.expiryFailed + counters.discordExpiryCalls;
  const operationId = `${prefix}expiry_${String(Date.now())}_${String(sequence).padStart(5, '0')}`;
  const guildId = guildIds[dominantGuildCount + (sequence % quietGuilds)];
  const targetId = String(400_000_000_000_000_000n + BigInt(sequence));
  const row = await prisma.moderationCase.create({ data: { guildId, actorId, targetId, action: 'TEMPBAN', reason: 'isolated expiry benchmark', status: 'succeeded', operationId, banMarker: `veyro-case-${operationId}`, banGeneration: 1, expiryStatus: 'scheduled', expiresAt: new Date(Date.now() - 1), createdAt: new Date() } });
  counters.expired++;
}

async function sample(elapsedSeconds) {
  const [counts, pending, oldestExpiry] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    prisma.moderationCase.aggregate({ where: { operationId: { startsWith: prefix }, status: { in: ['requested', 'running'] } }, _count: { _all: true }, _min: { createdAt: true } }),
    prisma.moderationCase.aggregate({ where: { operationId: { startsWith: prefix }, action: 'TEMPBAN', status: 'succeeded', expiryStatus: 'scheduled', expiresAt: { lte: new Date() } }, _count: { _all: true }, _min: { expiresAt: true } }),
  ]);
  const memory = process.memoryUsage();
  const admission = takeAdmissionMetrics();
  const pool = takePoolAcquireMetrics();
  lockWindows.push({ elapsedSeconds, ...admission });
  poolWindows.push({ elapsedSeconds, ...pool });
  const row = {
    elapsedSeconds, activeLoad, pendingAdmissions: pendingAdmission,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
    eventLoopP95Ms: loop.percentile(95) / 1e6,
    waitingJobs: counts.waiting ?? 0, activeJobs: counts.active ?? 0, delayedJobs: counts.delayed ?? 0,
    requestedRunning: pending._count._all, oldestRequestedMs: pending._min.createdAt ? Date.now() - pending._min.createdAt.getTime() : 0,
    scheduledOverdue: oldestExpiry._count._all, oldestExpiryMs: oldestExpiry._min.expiresAt ? Date.now() - oldestExpiry._min.expiresAt.getTime() : 0,
    poolTotal: postgresPool.totalCount, poolIdle: postgresPool.idleCount, poolWaiting: postgresPool.waitingCount,
  };
  samples.push(row);
  const progressBucket = Math.floor(elapsedSeconds / progressSeconds);
  if (progressSeconds > 0 && progressBucket > lastProgressBucket) {
    lastProgressBucket = progressBucket;
    console.log(JSON.stringify({ event: 'bench_progress', runId, elapsedSeconds: +elapsedSeconds.toFixed(1), activeLoad, offered: counters.offered, accepted: counters.accepted, refused: counters.refused, requestedRunning: row.requestedRunning, oldestRequestedMs: row.oldestRequestedMs, overdueExpiryCount: row.scheduledOverdue, oldestExpiryMs: row.oldestExpiryMs, rssBytes: row.rssBytes, heapUsedBytes: row.heapUsedBytes, poolWaiting: row.poolWaiting }));
  }
  loop.reset();
}

try {
  const preexisting = await prisma.moderationCase.count({ where: { status: { in: ['requested', 'running'] } } });
  if (preexisting) throw new Error(`Isolated benchmark DB has ${preexisting} active operations.`);
  const existingConfigs = await prisma.guildConfig.count({ where: { guildId: { in: guildIds } } });
  if (existingConfigs) throw new Error('One or more generated benchmark guild IDs already have configuration; refusing to overwrite them.');
  for (const guildId of guildIds) await prisma.guildConfig.upsert({ where: { guildId }, create: { guildId, updatedBy: actorId, memberActionsEnabled: true }, update: { updatedBy: actorId, memberActionsEnabled: true } });
  queue = new Queue(queueName, { connection: redisConnection(env.REDIS_URL, true) });
  await queue.waitUntilReady();
  const existingJobs = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  if (Object.values(existingJobs).some(value => value > 0)) throw new Error('Isolated Redis DB 9 queue is not empty; refusing to touch pre-existing jobs.');
  worker = createModerationWorker(mockClient, redisConnection(env.REDIS_URL), prisma, await import('@veyrobot/moderation'), (config, action, createdAt) => config?.memberActionsEnabled !== true && createdAt > (config?.updatedAt ?? new Date(0)), () => { if (dispatch) setImmediate(() => void dispatch()); }, {
    onAttemptStarted: recordAttemptStarted,
    onAttemptFinished: recordAttemptFinished,
    onGuildBusySkip: () => { busyGuildSkips++; },
  });
  worker.on('error', error => { counters.dispatchErrors++; console.error(JSON.stringify({ event: 'bench_worker_error', name: error?.name })); });
  dispatch = createDispatcher(prisma, queue, () => true, () => { counters.dispatchErrors++; }, recordEnqueueAttempt);
  dispatchTimer = setInterval(() => void dispatch(), dispatcherIntervalMs);
  expiryTimer = setInterval(() => { void createExpiry().catch(error => { counters.admissionErrors++; console.error(JSON.stringify({ event: 'bench_expiry_seed_error', name: error?.name })); }); }, expiryPerMinute === 0 ? 2_147_000_000 : 60_000 / expiryPerMinute);
  loop.enable();
  const cpuStarted = process.cpuUsage();
  const campaignStart = performance.now();
  campaignSampleTimer = setInterval(() => { void sample((performance.now() - campaignStart) / 1_000).catch(error => { counters.dispatchErrors++; console.error(JSON.stringify({ event: 'bench_sample_error', name: error?.name })); }); }, sampleSeconds * 1_000);
  activeLoad = true;
  let nextArrival = performance.now();
  while ((performance.now() - campaignStart) / 1_000 < seconds) {
    const now = performance.now();
    const elapsed = (now - campaignStart) / 1_000;
    const profile = chooseProfile(elapsed);
    if (now < nextArrival) { await sleep(Math.min(100, nextArrival - now)); continue; }
    const lag = Math.max(0, now - nextArrival);
    if (lag > 250) counters.arrivalsDelayed++;
    const guildId = profile.guild();
    const id = counters.offered;
    void admitAction(profile.name, guildId).catch(error => { console.error(JSON.stringify({ event: 'bench_admission_error', name: error?.name })); });
    nextArrival += 1_000 / profile.rps;
    if (pendingAdmission >= 128) await sleep(10);
    if (counters.offered === id) throw new Error('Arrival generator failed to advance.');
  }
  activeLoad = false;
  await sleep(Math.max(0, (seconds * 1_000) - (performance.now() - campaignStart)));
  while (pendingAdmission > 0 && performance.now() - campaignStart < (seconds * 1_000 + drainTimeoutMs)) await sleep(50);
  if (pendingAdmission > 0) throw new Error(`Admission drain timeout: ${pendingAdmission} requests remain in the generator.`);
  clearInterval(expiryTimer); expiryTimer = undefined;
  const drainStarted = Date.now();
  let pendingRows = 1;
  while (Date.now() - drainStarted < drainTimeoutMs) {
    const [actions, expiries] = await Promise.all([
      prisma.moderationCase.count({ where: { operationId: { startsWith: prefix }, status: { in: ['requested', 'running'] } } }),
      prisma.moderationCase.count({ where: { operationId: { startsWith: `${prefix}expiry_` }, expiryStatus: { in: ['scheduled', 'running'] } } }),
    ]);
    pendingRows = actions + expiries;
    if (pendingRows === 0) break;
    await dispatch(); await sleep(500);
  }
  const drainMs = Date.now() - drainStarted;
  await sample((performance.now() - campaignStart) / 1_000);
  const drainMemory = process.memoryUsage();
  if (pendingRows !== 0) throw new Error(`Drain timeout: ${pendingRows} rows remain.`);
  const idleStart = Date.now();
  while (Date.now() - idleStart < idleSeconds * 1_000) { await sleep(sampleSeconds * 1_000); await sample((performance.now() - campaignStart) / 1_000); }
  clearInterval(campaignSampleTimer); campaignSampleTimer = undefined;
  const afterIdle = process.memoryUsage();

  const rows = await prisma.moderationCase.findMany({ where: { operationId: { startsWith: prefix } }, select: { id: true, operationId: true, guildId: true, action: true, status: true, expiryStatus: true, createdAt: true, startedAt: true, completedAt: true, expiresAt: true, expiryStartedAt: true, unbannedAt: true } });
  const byCategory = new Map();
  for (const row of rows) {
    const id = row.operationId ?? '';
    const category = row.action === 'TEMPBAN' ? 'expiry' : id.startsWith(`${prefix}dominant_`) ? 'dominant' : id.startsWith(`${prefix}burst_`) ? 'burst' : 'quiet';
    const bucket = byCategory.get(category) ?? { accepted: 0, succeeded: 0, failed: 0, uncertain: 0 };
    bucket.accepted++;
    if (row.status === 'succeeded') bucket.succeeded++;
    if (row.status === 'failed') bucket.failed++;
    if (row.status === 'uncertain' || row.expiryStatus === 'uncertain') bucket.uncertain++;
    byCategory.set(category, bucket);
  }
  const actionRows = rows.filter(row => row.action !== 'TEMPBAN');
  const expiryRows = rows.filter(row => row.action === 'TEMPBAN');
  counters.completed = actionRows.filter(row => row.status === 'succeeded').length;
  counters.failed = actionRows.filter(row => row.status === 'failed').length;
  counters.uncertain = actionRows.filter(row => row.status === 'uncertain').length;
  counters.expiryUncertain = expiryRows.filter(row => row.expiryStatus === 'uncertain').length;
  counters.expiryFailed = expiryRows.filter(row => row.expiryStatus === 'failed').length;
  const idleSamples = samples.filter(row => row.elapsedSeconds >= (performance.now() - campaignStart) / 1_000 - idleSeconds - sampleSeconds);
  const cpu = process.cpuUsage(cpuStarted);
  console.log(JSON.stringify({
    runId, scope: 'production createDispatcher + createModerationWorker + executeModerationAction/expireTemporaryBan; local controlled Discord adapter; isolated PostgreSQL and Redis DB; no real Discord requests',
    machine: { node: process.version, platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model },
    config: { seconds, phaseSeconds, idleSeconds, quietGuilds, dominantGuildCount, normalRps, dominantRps, burstRps, burstSeconds, expiryPerMinute, discordDelayMs, sampleSeconds, drainTimeoutMs, workerConcurrency: 4, maxActivePerGuild: 1, admissionGlobal: Number(env.MAX_PENDING_GLOBAL ?? 5000), admissionPerGuild: Number(env.MAX_PENDING_PER_GUILD ?? 100), poolMax: Number(env.DATABASE_POOL_SIZE ?? 10), dispatcherIntervalMs, redisDatabase: redisDb, admissionPath: 'direct production PostgreSQL admission use case (not HTTP API)' },
    counts: { ...counters, busyGuildSkips, unmatchedEnqueueAttempts: enqueueAttemptTimes.size, rows: rows.length, terminal: actionRows.filter(row => ['succeeded', 'failed', 'uncertain'].includes(row.status)).length, expiredCompleted: expiryRows.filter(row => ['succeeded', 'failed', 'uncertain', 'superseded'].includes(row.expiryStatus)).length, pendingAfterDrain: pendingRows },
    latencyMs: Object.fromEntries(Object.entries(latency).map(([key, value]) => [key, summary(value)])),
    category: Object.fromEntries(byCategory),
    resourceSamples: { count: samples.length, intervalSeconds: sampleSeconds, oldestExpiryAgeIsSampled: true, activeHeapSlopeBytesPerMinute: elapsedSlopePerMinute(samples.filter(row => row.activeLoad), 'heapUsedBytes'), idleHeapSlopeBytesPerMinute: elapsedSlopePerMinute(idleSamples, 'heapUsedBytes'), idleRssSlopeBytesPerMinute: elapsedSlopePerMinute(idleSamples, 'rssBytes'), peakRssBytes: Math.max(...samples.map(row => row.rssBytes), drainMemory.rss), beforeDrainRssBytes: drainMemory.rss, afterIdleRssBytes: afterIdle.rss, beforeDrainHeapBytes: drainMemory.heapUsed, afterIdleHeapBytes: afterIdle.heapUsed, maxEventLoopP95Ms: +Math.max(...samples.map(row => row.eventLoopP95Ms)).toFixed(2), maxWaitingJobs: Math.max(...samples.map(row => row.waitingJobs)), maxActiveJobs: Math.max(...samples.map(row => row.activeJobs)), maxRequestedRunning: Math.max(...samples.map(row => row.requestedRunning)), maxOldestRequestMs: Math.max(...samples.map(row => row.oldestRequestedMs)), maxOverdueExpiryRows: Math.max(...samples.map(row => row.scheduledOverdue)), maxOldestExpiryMs: Math.max(...samples.map(row => row.oldestExpiryMs)), maxPoolTotal: Math.max(...samples.map(row => row.poolTotal)), maxPoolWaiting: Math.max(...samples.map(row => row.poolWaiting)), maxPgPoolAcquireWaitMs: Math.max(0, ...poolWindows.map(row => row.maxWaitMs)), totalPgPoolAcquisitions: poolWindows.reduce((sum, row) => sum + row.acquisitions, 0), totalAdmissionLockWaitMs: lockWindows.reduce((sum, row) => sum + row.lockWaitTotalMs, 0), maxAdmissionLockWaitMs: Math.max(0, ...lockWindows.map(row => row.lockWaitMaxMs)), totalAdmissionCountMs: lockWindows.reduce((sum, row) => sum + row.countTotalMs, 0), maxAdmissionCountMs: Math.max(0, ...lockWindows.map(row => row.countMaxMs)), maxAdmissionLockHeldMs: Math.max(0, ...lockWindows.map(row => row.lockHeldMaxMs)), admissionWindows: lockWindows.length, cpuUserMs: +(cpu.user / 1000).toFixed(2), cpuSystemMs: +(cpu.system / 1000).toFixed(2) },
    drainMs,
  }));
  if (counters.admissionErrors || counters.failed || counters.uncertain || counters.expiryUncertain || counters.expiryFailed || counters.dispatchErrors || counters.accepted !== counters.completed || counters.discordActionCalls !== counters.completed || counters.discordExpiryCalls !== counters.expired || pendingRows) process.exitCode = 1;
} finally {
  activeLoad = false;
  if (dispatchTimer) clearInterval(dispatchTimer);
  if (campaignSampleTimer) clearInterval(campaignSampleTimer);
  if (expiryTimer) clearInterval(expiryTimer);
  loop.disable();
  if (worker) await worker.close(true).catch(() => undefined);
  if (queue) await queue.close().catch(() => undefined);
  if (runId) {
    await prisma.moderationCase.deleteMany({ where: { operationId: { startsWith: prefix } } }).catch(() => undefined);
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: guildIds }, updatedBy: actorId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
}
