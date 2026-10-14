import { performance } from 'node:perf_hooks';
import { Client, Guild, GatewayIntentBits, ChannelType } from 'discord.js';

if (!global.gc) throw new Error('Run with node --expose-gc.');
const guildCount = Number(process.env.BENCH_GUILDS ?? 300);
const channels = Number(process.env.BENCH_CHANNELS ?? 10);
const roles = Number(process.env.BENCH_ROLES ?? 10);
if (![guildCount, channels, roles].every(Number.isInteger) || guildCount < 1 || guildCount > 2_000 || channels < 0 || channels > 100 || roles < 0 || roles > 100) throw new Error('Invalid benchmark size.');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const memory = () => { global.gc(); const { rss, heapUsed, external } = process.memoryUsage(); return { rss, heapUsed, external }; };
const before = memory();
const start = performance.now();
for (let index = 0; index < guildCount; index++) {
  const id = String(100_000_000_000_000_000n + BigInt(index * 1_000));
  const data = {
    id, name: `Fixture ${index}`, owner_id: id, shardId: 0, features: [],
    roles: Array.from({ length: roles }, (_, number) => ({ id: String(BigInt(id) + BigInt(number + 1)), name: `Role ${number}`, permissions: '0', position: number, color: 0, hoist: false, managed: false, mentionable: false })),
    channels: Array.from({ length: channels }, (_, number) => ({ id: String(BigInt(id) + BigInt(roles + number + 1)), guild_id: id, name: `channel-${number}`, type: ChannelType.GuildText, position: number, permission_overwrites: [] })),
    members: [], presences: [], voice_states: [], emojis: [],
  };
  client.guilds.cache.set(id, new Guild(client, data));
}
const elapsedMs = performance.now() - start;
const after = memory();
if (client.guilds.cache.size !== guildCount) throw new Error('Guild fixture count mismatch.');
const delta = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
console.log(JSON.stringify({ guildCount, channels, roles, elapsedMs: +elapsedMs.toFixed(2), before, after, delta, bytesPerGuild: Object.fromEntries(Object.entries(delta).map(([key, value]) => [key, Math.round(value / guildCount)])), scope: 'Synthetic discord.js Guild fixtures, no Gateway traffic or REST.' }));
client.guilds.cache.clear();
client.destroy();
