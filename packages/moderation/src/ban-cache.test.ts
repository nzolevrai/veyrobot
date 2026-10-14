import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, DiscordAPIError, GuildBanManager, PermissionFlagsBits, type Guild } from 'discord.js';
import type { ModerationCase } from '@veyrobot/db';
import { executeModerationAction, expireTemporaryBan } from './executor.js';

const guildId = '987654321012345678';
const actorId = '887654321012345678';
const targetId = '787654321012345678';

function fixture(initialReason: string) {
  const client = new Client({ intents: [] });
  let currentReason: string | null = initialReason;
  let reads = 0;
  let unbans = 0;
  const guild = {
    id: guildId,
    client,
    ownerId: '687654321012345679',
    members: {
      fetch: async ({ user }: { user: string }) => ({ id: user === actorId ? actorId : targetId, permissions: { bitfield: PermissionFlagsBits.BanMembers }, roles: { highest: { comparePositionTo: () => 1 } } }),
      fetchMe: async () => ({ permissions: { bitfield: PermissionFlagsBits.BanMembers, has: (flag: bigint) => (PermissionFlagsBits.BanMembers & flag) === flag }, roles: { highest: { comparePositionTo: () => 1 } } }),
      unban: async () => { unbans++; currentReason = null; },
    },
  } as unknown as Guild;
  const route = `/guilds/${guildId}/bans/${targetId}`;
  Object.defineProperty(client.rest, 'get', { configurable: true, value: async () => {
    reads++;
    if (currentReason === null) throw new DiscordAPIError({ message: 'Unknown Ban' }, 10026, 404, 'GET', route, { body: null, files: null });
    return { user: { id: targetId, username: 'fixture', discriminator: '0', avatar: null }, reason: currentReason };
  } });
  const bans = new GuildBanManager(guild);
  Object.defineProperty(guild, 'bans', { value: bans });
  const store = (initialStatus = 'succeeded') => {
    let status = initialStatus;
    let expiryStatus = 'scheduled';
    const updates: Record<string, unknown>[] = [];
    return { updates, moderationCase: { updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (where.status && where.status !== status) return { count: 0 };
      if (where.expiryStatus && where.expiryStatus !== expiryStatus) return { count: 0 };
      updates.push(data);
      if (data.status) status = String(data.status);
      if (data.expiryStatus) expiryStatus = String(data.expiryStatus);
      return { count: 1 };
    } } };
  };
  return { client, guild, bans, store, setReason: (value: string | null) => { currentReason = value; }, get reads() { return reads; }, get unbans() { return unbans; } };
}

test('temporary ban expiry reads a fresh cached-manager result after a second ban uses a new marker', async () => {
  const discord = fixture('temporary [veyro-case-old]');
  try {
    await discord.bans.fetch({ user: targetId, force: true });
    assert.equal(discord.bans.cache.size, 1, 'fixture begins with one actual cached GuildBan');
    discord.setReason('temporary again [veyro-case-new]');
    const store = discord.store();
    const row = { id: 'case-new', guildId, actorId, targetId, action: 'TEMPBAN', status: 'succeeded', expiresAt: new Date(0), banMarker: 'veyro-case-new', expiryStatus: 'scheduled' } as ModerationCase;
    await expireTemporaryBan({ guild: discord.guild, caseRecord: row, store });
    assert.equal(discord.reads, 2, 'the executor must bypass discord.js cache at the expiry decision');
    assert.equal(discord.unbans, 1);
    assert.equal(discord.bans.cache.size, 1, 'cache:false fresh reads must not add a cached ban per operation');
    assert.equal(store.updates.at(-1)?.expiryStatus, 'succeeded');
  } finally { discord.client.destroy(); }
});

test('UNBAN treats a cached ban as absent when REST freshly reports 404', async () => {
  const discord = fixture('old ban [veyro-case-old]');
  try {
    await discord.bans.fetch({ user: targetId, force: true });
    discord.setReason(null);
    assert.equal(discord.bans.cache.size, 1, 'fixture retains the stale ban to reproduce the issue');
    const store = discord.store('requested');
    const row = { id: 'case-unban', guildId, actorId, targetId, action: 'UNBAN', reason: 'already removed', status: 'requested', createdAt: new Date() } as ModerationCase;
    await executeModerationAction({ operationId: 'unban-operation-0001', guild: discord.guild, caseRecord: row, store: store as never });
    assert.equal(discord.reads, 2, 'UNBAN must perform a cache-bypassing REST read');
    assert.equal(discord.unbans, 0);
    assert.equal(discord.bans.cache.size, 1, 'the cache-bypassing 404 read does not add entries');
    assert.equal(store.updates.at(-1)?.status, 'succeeded');
  } finally { discord.client.destroy(); }
});
