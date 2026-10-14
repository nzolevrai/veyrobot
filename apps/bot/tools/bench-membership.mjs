import { performance } from 'node:perf_hooks';

const count = Number(process.env.BENCH_GUILDS ?? 20_000);
const shards = Number(process.env.BENCH_SHARDS ?? 4);
const mode = process.env.BENCH_GROUP_MODE ?? 'copy';
if (!Number.isInteger(count) || count < 1 || count > 200_000 || !Number.isInteger(shards) || shards < 1 || shards > 100 || !['copy', 'push'].includes(mode)) throw new Error('Invalid benchmark input.');
const guilds = Array.from({ length: count }, (_, index) => ({ id: String(100_000_000_000_000_000n + BigInt(index)), shardId: index % shards }));
global.gc?.();
const before = process.memoryUsage();
const cpuStart = process.cpuUsage();
const start = performance.now();
const membershipByShard = new Map();
for (const guild of guilds) {
  if (mode === 'copy') membershipByShard.set(guild.shardId, [...(membershipByShard.get(guild.shardId) ?? []), guild.id]);
  else {
    let ids = membershipByShard.get(guild.shardId);
    if (!ids) { ids = []; membershipByShard.set(guild.shardId, ids); }
    ids.push(guild.id);
  }
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
const actual = [...membershipByShard.values()].reduce((sum, ids) => sum + ids.length, 0);
if (actual !== count) throw new Error(`Lost guilds: ${actual}/${count}`);
console.log(JSON.stringify({ mode, count, shards, elapsedMs: +elapsedMs.toFixed(2), cpuMs: +((cpu.user + cpu.system) / 1_000).toFixed(2), heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed, rssBytes: process.memoryUsage().rss }));
