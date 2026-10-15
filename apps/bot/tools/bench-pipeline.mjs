import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { prisma, withModerationAdmission } from '@veyrobot/db';
import { redisConnection } from '@veyrobot/moderation';
import { createDispatcher } from '../dist/dispatcher.js';

const rps = Number(process.env.BENCH_OFFERED_RPS ?? 40);
const seconds = Number(process.env.BENCH_SECONDS ?? 6);
const guildCount = Number(process.env.BENCH_GUILDS ?? 10);
const restDelayMs = Number(process.env.BENCH_REST_DELAY_MS ?? 10);
const admission = process.env.BENCH_ADMISSION ?? 'on';
const profile = process.env.BENCH_PROFILE ?? 'many';
if (![rps, seconds, guildCount, restDelayMs].every(Number.isFinite) || rps < 1 || rps > 200 || seconds < 1 || seconds > 180 || guildCount < 1 || guildCount > 1_000 || restDelayMs < 0 || restDelayMs > 1_000 || !['on', 'off'].includes(admission) || !['many', 'dominant', 'bursts'].includes(profile)) throw new Error('Invalid benchmark inputs.');
if (!process.env.DATABASE_URL?.includes('veyrobot_arch_bench')) throw new Error('Use the isolated veyrobot_arch_bench database.');
if (!process.env.REDIS_URL?.endsWith('/9')) throw new Error('Use isolated Redis DB 9.');
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const queueName = `veyrobot-bench-${runId}`;
const queue = new Queue(queueName, { connection: redisConnection(process.env.REDIS_URL, true) });
const activeGuilds = new Set();
const offeredAt = new Map();
const acceptedAt = new Map();
const admissionMs = [], queueMs = [], processingMs = [], endToEndMs = [], arrivalLagMs = [];
let offered = 0, accepted = 0, rejected = 0, admissionErrors = 0, completed = 0, failed = 0, uncertain = 0, discordCalls = 0, maxDepth = 0, maxOldestMs = 0, maxConnections = 0, sqlLockWaiters = 0;
let dispatchErrors = 0;
let worker;
let dispatchTimer;
let sampleTimer;
const mock = createServer(async (_request, response) => {
  discordCalls++;
  await delay(restDelayMs);
  response.writeHead(204).end();
});
const quantile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return +(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0).toFixed(2); };
const summary = values => ({ p50: quantile(values, .5), p95: quantile(values, .95), p99: quantile(values, .99) });
const loop = monitorEventLoopDelay({ resolution: 10 });
try {
  const preexisting = await prisma.moderationCase.count({ where: { status: { in: ['requested', 'running'] } } });
  if (preexisting) throw new Error(`Isolated benchmark DB contains ${preexisting} active rows; clean test fixtures before measuring.`);
  await queue.waitUntilReady();
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const port = mock.address().port;
  const dispatch = createDispatcher(prisma, queue, () => true, () => { dispatchErrors++; });
  worker = new Worker(queueName, async job => {
    const { guildId, operationId } = job.data;
    if (activeGuilds.has(guildId)) return;
    activeGuilds.add(guildId);
    try {
      const row = await prisma.moderationCase.findUnique({ where: { operationId } });
      if (!row || row.guildId !== guildId || row.status !== 'requested') return;
      const token = randomUUID();
      const claim = await prisma.moderationCase.updateMany({ where: { id: row.id, status: 'requested' }, data: { status: 'running', claimToken: token, startedAt: new Date(), executionPhase: 'preparing', claimLeaseUntil: new Date(Date.now() + 120_000) } });
      if (claim.count !== 1) return;
      const began = performance.now();
      queueMs.push(began - acceptedAt.get(operationId));
      await prisma.moderationCase.updateMany({ where: { id: row.id, status: 'running', claimToken: token }, data: { executionPhase: 'discord_request_inflight' } });
      let status = 'succeeded';
      try { const response = await fetch(`http://127.0.0.1:${port}/discord`); if (!response.ok) status = response.status >= 500 ? 'uncertain' : 'failed'; }
      catch { status = 'uncertain'; }
      const finish = await prisma.moderationCase.updateMany({ where: { id: row.id, status: 'running', claimToken: token }, data: { status, completedAt: new Date(), result: 'benchmark simulated REST' } });
      if (finish.count !== 1) throw new Error('Lost claim fencing in benchmark.');
      const ended = performance.now();
      processingMs.push(ended - began);
      endToEndMs.push(ended - offeredAt.get(operationId));
      acceptedAt.delete(operationId);
      completed++;
      if (status === 'failed') failed++;
      if (status === 'uncertain') uncertain++;
    } finally { activeGuilds.delete(guildId); void dispatch(); }
  }, { connection: redisConnection(process.env.REDIS_URL), concurrency: 4, removeOnComplete: { count: 0 }, removeOnFail: { count: 0 } });
  dispatchTimer = setInterval(() => void dispatch(), 100);
  sampleTimer = setInterval(() => {
    maxDepth = Math.max(maxDepth, accepted - completed);
    if (acceptedAt.size) maxOldestMs = Math.max(maxOldestMs, performance.now() - Math.min(...acceptedAt.values()));
    void prisma.$queryRaw`SELECT COUNT(*)::integer AS count, COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::integer AS waiting FROM pg_stat_activity WHERE datname = current_database()`
      .then(rows => { maxConnections = Math.max(maxConnections, rows[0]?.count ?? 0); sqlLockWaiters = Math.max(sqlLockWaiters, rows[0]?.waiting ?? 0); }).catch(() => undefined);
  }, 250);
  loop.enable();
  const cpuStart = process.cpuUsage();
  const eluStart = performance.eventLoopUtilization();
  const start = performance.now();
  const admissions = [];
  const total = Math.floor(rps * seconds);
  for (let index = 0; index < total; index++) {
    const due = start + (profile === 'bursts' ? Math.floor(index / Math.max(1, Math.floor(rps * 5))) * 5_000 : index * 1_000 / rps);
    setTimeout(() => {
      const now = performance.now();
      arrivalLagMs.push(Math.max(0, now - due));
      offered++;
      const operationId = `bench_${runId}_${index}`;
      const guildIndex = profile === 'dominant' && index % 5 !== 0 ? 0 : index % guildCount;
      const guildId = String(100_000_000_000_000_000n + BigInt(guildIndex));
      offeredAt.set(operationId, now);
      const data = { operationId, guildId, actorId: '123456789012345679', targetId: '123456789012345680', action: 'KICK', reason: 'pipeline benchmark', status: 'requested' };
      const create = admission === 'on' ? withModerationAdmission(prisma, guildId, operationId, tx => tx.moderationCase.create({ data })) : prisma.moderationCase.create({ data });
      admissions.push(create.then(() => { accepted++; acceptedAt.set(operationId, performance.now()); admissionMs.push(performance.now() - now); }).catch(error => { if (error?.code === 'MODERATION_BACKLOG_LIMIT') rejected++; else admissionErrors++; offeredAt.delete(operationId); }));
    }, Math.max(0, due - performance.now()));
  }
  await delay(seconds * 1_000 + 100);
  await Promise.all(admissions);
  const deadline = Date.now() + Math.max(30_000, seconds * 1_000);
  while (completed < accepted && Date.now() < deadline) { await dispatch(); await delay(100); }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const memory = process.memoryUsage();
  await delay(2_000);
  const idleMemory = process.memoryUsage();
  const elu = performance.eventLoopUtilization(eluStart);
  loop.disable();
  const connections = await prisma.$queryRaw`SELECT COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database()`;
  console.log(JSON.stringify({ runId, scope: 'isolated PostgreSQL + BullMQ + local HTTP mock; not production executor, Discord Gateway or REST', machine: { node: process.version, platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model }, config: { rps, seconds, guildCount, restDelayMs, admission, profile, concurrency: 4, poolMax: Number(process.env.DATABASE_POOL_SIZE ?? 10) }, counts: { offered, accepted, rejected, admissionErrors, completed, failed, uncertain, discordCalls, dispatchErrors }, rates: { offeredPerSecond: +(offered / seconds).toFixed(2), acceptedPerSecond: +(accepted / seconds).toFixed(2), completedPerSecond: +(completed / (elapsedMs / 1_000)).toFixed(2) }, latencyMs: { arrivalLag: summary(arrivalLagMs), admission: summary(admissionMs), queue: summary(queueMs), processing: summary(processingMs), endToEnd: summary(endToEndMs) }, queue: { maxDepth, maxOldestMs: +maxOldestMs.toFixed(2), unfinished: accepted - completed }, resources: { cpuUserMs: +(cpu.user / 1_000).toFixed(2), cpuSystemMs: +(cpu.system / 1_000).toFixed(2), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, idleRssBytes: idleMemory.rss, idleHeapUsedBytes: idleMemory.heapUsed, eventLoopUtilization: +elu.utilization.toFixed(4), eventLoopDelayP95Ms: +(loop.percentile(95) / 1e6).toFixed(2), connections: connections[0]?.count, maxConnections, maxSqlLockWaiters: sqlLockWaiters, poolWait: 'not instrumented' } }));
  if (admissionErrors || (rejected && process.env.BENCH_EXPECT_REJECTIONS !== '1') || failed || uncertain || completed !== accepted || discordCalls !== completed || dispatchErrors) process.exitCode = 1;
} finally {
  if (dispatchTimer) clearInterval(dispatchTimer);
  if (sampleTimer) clearInterval(sampleTimer);
  loop.disable();
  if (worker) await worker.close(true).catch(() => undefined);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close().catch(() => undefined);
  await new Promise(resolve => mock.close(resolve));
  await prisma.moderationCase.deleteMany({ where: { operationId: { startsWith: `bench_${runId}_` } } });
  await prisma.$disconnect();
}
