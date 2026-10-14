import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma, postgresPool, takeAdmissionMetrics, takePoolAcquireMetrics, withModerationAdmission } from '@veyrobot/db';

if (!process.env.DATABASE_URL?.includes('veyrobot_arch_bench')) throw new Error('Use the isolated veyrobot_arch_bench database.');
const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const prefix = `admbench_${runId}_`;
const sizes = (process.env.ADMISSION_SIZES ?? '0,1000,4000,5000').split(',').map(Number);
const rounds = Number(process.env.ADMISSION_ROUNDS ?? 12);
const poolMax = postgresPool.options.max ?? 10;
const actorId = '123456789012345679';
const baseGuild = 500_000_000_000_000_000n;
const result = [];
let inserted = 0;
try {
  if (sizes.some(size => !Number.isInteger(size) || size < 0 || size > 100_000) || !Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('Invalid admission benchmark settings.');
  if (await prisma.moderationCase.count({ where: { operationId: { startsWith: prefix } } })) throw new Error('Generated operation prefix already exists.');
  const existingActive = await prisma.moderationCase.count({ where: { status: { in: ['requested', 'running'] } } });
  if (existingActive) throw new Error(`Isolated DB contains ${existingActive} active rows; run only after the production campaign has cleaned its fixtures.`);
  let targetSize = 0;
  for (const size of sizes) {
    if (size < targetSize) throw new Error('Admission sizes must be sorted ascending.');
    while (targetSize < size) {
      const count = Math.min(500, size - targetSize);
      const data = Array.from({ length: count }, (_, offset) => ({
        operationId: `${prefix}seed_${targetSize + offset}`, guildId: String(baseGuild + BigInt((targetSize + offset) % 50)), actorId,
        targetId: String(600_000_000_000_000_000n + BigInt(targetSize + offset)), action: 'KICK', reason: 'admission benchmark seed', status: 'requested',
      }));
      await prisma.moderationCase.createMany({ data });
      targetSize += count; inserted += count;
    }
    takeAdmissionMetrics(); takePoolAcquireMetrics();
    const samples = [];
    const refused = { n: 0 };
    const jobs = Array.from({ length: rounds }, (_, round) => withModerationAdmission(prisma, String(baseGuild + 100n), `${prefix}probe_${size}_${round}`, async tx => {
      const started = performance.now();
      const row = await tx.moderationCase.create({ data: { operationId: `${prefix}probe_${size}_${round}`, guildId: String(baseGuild + 100n), actorId, targetId: String(700_000_000_000_000_000n + BigInt(round)), action: 'KICK', reason: 'admission benchmark probe', status: 'failed' } });
      samples.push(performance.now() - started);
      return row;
    }).catch(error => { if (error?.code === 'MODERATION_BACKLOG_LIMIT') { refused.n++; return null; } throw error; }));
    await Promise.all(jobs);
    const admission = takeAdmissionMetrics();
    const pool = takePoolAcquireMetrics();
    const sorted = [...samples].sort((a, b) => a - b);
    const quantile = p => +(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0).toFixed(2);
    result.push({ activeRows: size, rounds, accepted: samples.length, refused: refused.n, wallMs: +Math.max(...samples, 0).toFixed(2), createP50Ms: quantile(.5), createP95Ms: quantile(.95), admission, poolAcquisition: pool });
  }
  const holders = await Promise.all(Array.from({ length: poolMax }, () => postgresPool.connect()));
  takePoolAcquireMetrics();
  const waiter = postgresPool.connect();
  await sleep(150);
  holders[0]?.release();
  const waiterClient = await waiter;
  const forcedWait = takePoolAcquireMetrics();
  waiterClient.release();
  for (const holder of holders.slice(1)) holder.release();
  console.log(JSON.stringify({ runId, scope: 'isolated real PostgreSQL, installed PrismaPg adapter and underlying pg.Pool; admission workload and a controlled pool acquisition wait; no Discord/Redis worker', poolMax, admissionLimitGlobal: Number(process.env.MAX_PENDING_GLOBAL ?? 5000), admissionLimitPerGuild: Number(process.env.MAX_PENDING_PER_GUILD ?? 100), result, forcedPoolWait: { heldConnections: poolMax, releaseAfterMs: 150, observed: forcedWait } }));
} finally {
  await prisma.moderationCase.deleteMany({ where: { operationId: { startsWith: prefix } } }).catch(() => undefined);
  await prisma.$disconnect();
}
