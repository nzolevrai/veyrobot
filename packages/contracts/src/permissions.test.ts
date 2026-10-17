import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMINISTRATOR, canManageGuild, canModerateMembers, hasPermissionBits, MANAGE_GUILD, MODERATE_MEMBERS } from './index.js';
import { canonicalizeClientIp, clientIpSigningPayload } from './client-ip.js';

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

test('canonicalizes equivalent IP literals without grouping unrelated networks', () => {
  assert.equal(canonicalizeClientIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(canonicalizeClientIp('2001:db8::1'), '2001:db8::1');
  assert.equal(canonicalizeClientIp('192.0.2.1'), '192.0.2.1');
  assert.equal(canonicalizeClientIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(canonicalizeClientIp('::FFFF:C000:0201'), '192.0.2.1');
  assert.equal(canonicalizeClientIp('2001:db8::2'), '2001:db8::2');
});

test('preserves IPv6 identity for strictly validated dotted tails', () => {
  const equivalentPairs = [
    ['::1.2.3.4', '::102:304'],
    ['0:0:0:0:0:0:1.2.3.4', '::102:304'],
    ['::0.0.0.1', '::1'],
    ['0:0:0:0:0:0:0.0.0.1', '::1'],
    ['::ffff:192.0.2.1', '::ffff:c000:201'],
    ['0:0:0:0:0:ffff:192.0.2.1', '192.0.2.1'],
  ] as const;
  for (const [dotted, hexadecimal] of equivalentPairs) {
    const canonical = canonicalizeClientIp(dotted);
    assert.ok(canonical, `${dotted} should be a valid IP literal`);
    assert.equal(canonical, canonicalizeClientIp(hexadecimal), `${dotted} and ${hexadecimal} should share identity`);
    assert.equal(canonicalizeClientIp(canonical), canonical, `${dotted} canonicalization should be idempotent`);
  }
  assert.equal(canonicalizeClientIp('::1.2.3.4'), '::102:304');
  assert.notEqual(canonicalizeClientIp('::1.2.3.4'), canonicalizeClientIp('1.2.3.4'));
  assert.equal(canonicalizeClientIp('::0.0.0.1'), '::1');
  assert.notEqual(canonicalizeClientIp('::0.0.0.1'), canonicalizeClientIp('0.0.0.1'));
  assert.equal(canonicalizeClientIp('64:ff9b::192.0.2.1'), '64:ff9b::c000:201', 'NAT64 remains IPv6');
  assert.notEqual(canonicalizeClientIp('64:ff9b::192.0.2.1'), canonicalizeClientIp('192.0.2.1'));
});

test('rejects ambiguous, decorated, unsupported, and overlong client address values', () => {
  for (const invalid of [
    '', ' 192.0.2.1', '192.0.2.1 ', '192.0.2.1, 198.51.100.1', '192.0.2.1:443',
    '[2001:db8::1]', '2001:db8::1%eth0', '2001:db8::1/64', '192.000.2.1',
    '256.0.0.1', '1.2.3', '2001:::1', 'g001::1', 'a'.repeat(46),
  ]) assert.equal(canonicalizeClientIp(invalid), null, `must reject ${JSON.stringify(invalid)}`);
  assert.equal(canonicalizeClientIp(['192.0.2.1']), null);
});

test('uses an explicit versioned signing payload', () => {
  assert.equal(clientIpSigningPayload('192.0.2.1'), 'veyrobot-client-ip:v1\n192.0.2.1');
});
