import type { Client } from 'discord.js';

/** Aggregate cache gauges only; no guild, channel, member, or user identifiers leave this function. */
export function readBotCacheCounts(client: Client): {
  guilds: number;
  channels: number;
  users: number;
  emojis: number;
  roles: number;
  members: number;
  bans: number;
} {
  let roles = 0;
  let members = 0;
  let bans = 0;
  // One O(guilds) pass per operational snapshot; manager sizes are O(1), and
  // no individual role/member/ban collection is copied or traversed.
  for (const guild of client.guilds.cache.values()) {
    roles += guild.roles.cache.size;
    members += guild.members.cache.size;
    bans += guild.bans.cache.size;
  }
  return {
    guilds: client.guilds.cache.size,
    channels: client.channels.cache.size,
    users: client.users.cache.size,
    emojis: client.emojis.cache.size,
    roles,
    members,
    bans,
  };
}
