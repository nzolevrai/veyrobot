import test from 'node:test';
import assert from 'node:assert/strict';
import { readBotCacheCounts } from '../dist/resource-snapshot.js';

test('cache snapshot aggregates manager sizes without exposing identifiers', () => {
  const guild = (roles, members, bans) => ({
    roles: { cache: new Map(roles.map(id => [id, {}])) },
    members: { cache: new Map(members.map(id => [id, {}])) },
    bans: { cache: new Map(bans.map(id => [id, {}])) },
  });
  const client = {
    guilds: { cache: new Map([
      ['guild-secret-1', guild(['role-a', 'role-b'], ['member-a'], [])],
      ['guild-secret-2', guild(['role-c'], ['member-b', 'member-c'], ['ban-a'])],
    ]) },
    channels: { cache: new Map([['channel-secret', {}]]) },
    users: { cache: new Map([['user-secret', {}], ['bot-secret', {}]]) },
    emojis: { cache: new Map([['emoji-secret', {}]]) },
  };

  const result = readBotCacheCounts(client);
  assert.deepEqual(result, { guilds: 2, channels: 1, users: 2, emojis: 1, roles: 3, members: 3, bans: 1 });
  const serialized = JSON.stringify(result);
  for (const identifier of ['guild-secret', 'role-a', 'member-a', 'ban-a', 'channel-secret', 'user-secret', 'emoji-secret']) {
    assert.equal(serialized.includes(identifier), false);
  }
});
