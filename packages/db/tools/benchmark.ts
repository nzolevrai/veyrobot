import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');
const perProfile = Number(process.env.BENCH_EVENTS_PER_PROFILE ?? 2_000);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 16);
const maxRssBytes = Number(process.env.BENCH_MAX_RSS_MB ?? 512) * 1024 * 1024;
if (!Number.isInteger(perProfile) || perProfile < 30 || perProfile > 50_000) throw new Error('BENCH_EVENTS_PER_PROFILE must be 30..50000.');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) throw new Error('BENCH_CONCURRENCY must be 1..128.');

const pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), connectionTimeoutMillis: 3_000, idleTimeoutMillis: 10_000 });
const runId = randomUUID().replaceAll('-', '').slice(0, 16);
const suffix = runId;
const profiles = [
  { name: 'many_quiet_guilds', guilds: 1_000, perGuild: Math.max(1, Math.floor(perProfile / 1_000)) },
  { name: 'few_busy_guilds', guilds: 10, perGuild: Math.ceil(perProfile / 10) },
  { name: 'single_guild_burst', guilds: 1, perGuild: perProfile },
];
const sourceEvents = profiles.flatMap((profile, profileIndex) => Array.from({ length: profile.guilds * profile.perGuild }, (_, i) => ({ profile: profile.name, guildId: String(100_000_000_000_000_000 + profileIndex * 10_000_000 + i % profile.guilds), operationId: `bench_${suffix}_${profileIndex}_${i}`, enqueuedAt: performance.now() })));
// Interleave guild lanes so burst traffic cannot occupy every simulated worker slot.
const laneMap = new Map<string, typeof sourceEvents>();
for (const event of sourceEvents) {
  const lane = laneMap.get(event.guildId);
  if (lane) lane.push(event); else laneMap.set(event.guildId, [event]);
}
const lanes = [...laneMap.values()];
const events: typeof sourceEvents = [];
for (let offset = 0; lanes.some(lane => lane[offset] !== undefined); offset++) for (const lane of lanes) if (lane[offset]) events.push(lane[offset]!);
const latencies: number[] = [];
const waits: number[] = [];
const byProfile = new Map(profiles.map(p => [p.name, { count: 0, latencies: [] as number[] }]));
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const cpuStart = process.cpuUsage();
const start = performance.now();
let cursor = 0;
let completed = 0;
let maxQueueDepth = events.length;
let maxPoolWaiting = 0;
let maxRss = process.memoryUsage().rss;
let memoryBudgetExceeded = false;
const memoryTimer = setInterval(() => {
  maxRss = Math.max(maxRss, process.memoryUsage().rss);
  if (maxRss > maxRssBytes) memoryBudgetExceeded = true;
  maxPoolWaiting = Math.max(maxPoolWaiting, pool.waitingCount);
}, 25);
const actorId = '123456789012345679';
const targetId = '123456789012345680';
const worker = async () => {
  while (true) {
    if (memoryBudgetExceeded) return;
    const index = cursor++;
    if (index >= events.length) return;
    const event = events[index]!;
    const began = performance.now();
    waits.push(began - event.enqueuedAt);
    const id = randomUUID();
    const created = new Date();
    await pool.query('INSERT INTO "ModerationCase" ("id", "operationId", "guildId", "actorId", "targetId", "action", "reason", "status", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, event.operationId, event.guildId, actorId, targetId, 'WARN', 'benchmark simulation', 'requested', created]);
    const claimed = await pool.query('UPDATE "ModerationCase" SET "status"=$1, "startedAt"=NOW() WHERE "operationId"=$2 AND "status"=$3', ['running', event.operationId, 'requested']);
    if (claimed.rowCount !== 1) throw new Error('Benchmark claim was not exclusive.');
    await pool.query('UPDATE "ModerationCase" SET "status"=$1, "completedAt"=NOW(), "result"=$2 WHERE "operationId"=$3 AND "status"=$4', ['succeeded', 'simulated only', event.operationId, 'running']);
    const latency = performance.now() - began;
    latencies.push(latency); byProfile.get(event.profile)!.latencies.push(latency);
    completed++; maxQueueDepth = Math.max(maxQueueDepth, events.length - completed);
  }
};
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0;
}
try {
  const server = await pool.query<{ version: string }>('SELECT version() AS version');
  const initialConnections = pool.totalCount;
  await Promise.all(Array.from({ length: concurrency }, worker));
  maxRss = Math.max(maxRss, process.memoryUsage().rss);
  if (memoryBudgetExceeded) throw new Error(`RSS exceeded configured budget ${Math.round(maxRssBytes / 1024 / 1024)} MiB.`);
  const reconcileStart = performance.now();
  const reconciled = await pool.query('SELECT "guildId", "operationId" FROM "ModerationCase" WHERE "status"=$1 AND "operationId" IS NOT NULL ORDER BY "createdAt" ASC LIMIT 100', ['requested']);
  const reconciliationMs = performance.now() - reconcileStart;
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  maxRss = Math.max(maxRss, process.memoryUsage().rss);
  if (maxRss > maxRssBytes) throw new Error(`RSS exceeded configured budget ${Math.round(maxRssBytes / 1024 / 1024)} MiB.`);
  const report = {
    runId, safety: 'PostgreSQL writes only; Discord API was not called; all inserted rows are removed in finally.',
    machine: { platform: `${os.type()} ${os.release()}`, architecture: os.arch(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem(), node: process.version, postgres: server.rows[0]?.version },
    profile: { perProfile, simulatedEvents: events.length, concurrency, poolMax: pool.options.max, memoryBudgetMiB: Math.round(maxRssBytes / 1024 / 1024), durationMs: Math.round(elapsedMs) },
    aggregate: { throughputPerSecond: Math.round(completed / elapsedMs * 1_000), latencyMs: { p50: +quantile(latencies, .50).toFixed(2), p95: +quantile(latencies, .95).toFixed(2), p99: +quantile(latencies, .99).toFixed(2) }, queueWaitMs: { p50: +quantile(waits, .50).toFixed(2), p95: +quantile(waits, .95).toFixed(2), p99: +quantile(waits, .99).toFixed(2) }, cpuUserMs: Math.round(cpu.user / 1_000), cpuSystemMs: Math.round(cpu.system / 1_000), rssBytes: process.memoryUsage().rss, peakSampledRssBytes: maxRss, heapUsedBytes: process.memoryUsage().heapUsed, memoryBudgetPassed: !memoryBudgetExceeded, eventLoopDelayMs: { mean: +(loop.mean / 1e6).toFixed(2), p95: +(loop.percentile(95) / 1e6).toFixed(2), max: +(loop.max / 1e6).toFixed(2) }, poolConnections: { initial: initialConnections, total: pool.totalCount, idle: pool.idleCount, peakWaiting: maxPoolWaiting }, queryCount: completed * 3 + 2, reconciliationMs: +reconciliationMs.toFixed(2), reconciliationRows: reconciled.rowCount, maxSimulatedQueueDepth: maxQueueDepth },
    profiles: Object.fromEntries([...byProfile].map(([name, data]) => [name, { events: data.latencies.length, latencyMs: { p50: +quantile(data.latencies, .50).toFixed(2), p95: +quantile(data.latencies, .95).toFixed(2), p99: +quantile(data.latencies, .99).toFixed(2) } }]))
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(memoryTimer); loop.disable();
  await pool.query('DELETE FROM "ModerationCase" WHERE "operationId" LIKE $1', [`bench_${suffix}_%`]).catch(() => undefined);
  await pool.end();
}
