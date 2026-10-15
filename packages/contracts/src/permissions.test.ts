import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMINISTRATOR, canManageGuild, canModerateMembers, hasPermissionBits, MANAGE_GUILD, MODERATE_MEMBERS } from './index.js';

test('guild access requires Manage Guild unless the user owns that guild', () => {
  assert.equal(canManageGuild(false, '0'), false);
  assert.equal(canManageGuild(false, '32'), true);
  assert.equal(canManageGuild(true, '0'), true);
});

test('moderation action permission is checked independently from dashboard access', () => {
  assert.equal(canModerateMembers(false, '32'), false);
  assert.equal(canModerateMembers(false, '1099511627776'), true);
  assert.equal(canModerateMembers(true, '0'), true);
});

test('Administrator grants effective guild and moderation permissions', () => {
  const administrator = ADMINISTRATOR.toString();
  assert.equal(canManageGuild(false, administrator), true);
  assert.equal(canModerateMembers(false, administrator), true);
  assert.equal(hasPermissionBits(ADMINISTRATOR, 1n << 2n), true);
  assert.equal(hasPermissionBits(1n << 2n, 1n << 2n), true);
  assert.equal(hasPermissionBits(0n, 1n << 2n), false);
  assert.equal(hasPermissionBits(ADMINISTRATOR, MANAGE_GUILD), true);
  assert.equal(hasPermissionBits(ADMINISTRATOR, MODERATE_MEMBERS), true);
});

test('permissions cannot be borrowed from a different guild context', () => {
  const userGuildPermissions = new Map([['guild-A', '32'], ['guild-B', '0']]);
  assert.equal(canManageGuild(false, userGuildPermissions.get('guild-A')!), true);
  assert.equal(canManageGuild(false, userGuildPermissions.get('guild-B')!), false);
});
