import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canActOnTarget, hasModerationPermission, validateModerationInput, ModerationRuleError, executeModerationAction, expireTemporaryBan, markInterruptedOperationsUncertain, submitModerationAction } from './index.js';
import { PermissionFlagsBits, type Guild } from 'discord.js';
import type { ModerationCase } from '@veyrobot/db';

function fakeCaseStore(initialStatus = 'requested', initialExpiry = 'scheduled') {
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  let status = initialStatus;
  let expiryStatus = initialExpiry;
  let token: unknown;
  let expiryToken: unknown;
  return { updates, moderationCase: { updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (where.status && where.status !== status) return { count: 0 };
    if (where.expiryStatus && where.expiryStatus !== expiryStatus) return { count: 0 };
    if (where.claimToken && token !== where.claimToken) return { count: 0 };
    if (where.expiryClaimToken && expiryToken !== where.expiryClaimToken) return { count: 0 };
    updates.push({ where, data });
    if (data.status) status = String(data.status);
    if (data.expiryStatus) expiryStatus = String(data.expiryStatus);
    if ('claimToken' in data) token = data.claimToken;
    if ('expiryClaimToken' in data) expiryToken = data.expiryClaimToken;
    return { count: 1 };
  } } };
}

test('rejects empty reasons and timeouts longer than Discord’s 28 day limit', () => {
  const base = { guildId: '123456789012345678', actorId: '123456789012345679', targetId: '123456789012345680', action: 'TIMEOUT' as const, reason: 'spam', durationMinutes: 40_320 };
  assert.doesNotThrow(() => validateModerationInput(base));
  assert.throws(() => validateModerationInput({ ...base, durationMinutes: 40_321 }), ModerationRuleError);
  assert.throws(() => validateModerationInput({ ...base, reason: ' ' }), ModerationRuleError);
});

test('action requests are persisted in PostgreSQL and need no Redis write from the API', async () => {
  const writes: Record<string, unknown>[] = [];
  const row = { id: 'case-1', guildId: '123456789012345678', actorId: '123456789012345679', targetId: '123456789012345680', action: 'KICK', reason: 'spam', status: 'requested', createdAt: new Date() };
  const store = { moderationCase: { findUnique: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return row as never; }, update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); } } };
  const result = await submitModerationAction(store, { guildId: row.guildId, actorId: row.actorId, targetId: row.targetId, action: 'KICK', reason: row.reason, operationId: 'operation-id-0001' });
  assert.equal(result.status, 'requested');
  assert.equal(writes.length, 1);
});
test('disabled module rejects a new action before a case is created', async () => {
  let writes = 0;
  const store = { guildConfig: { findUnique: async () => ({ warningsEnabled: false, memberActionsEnabled: false, channelActionsEnabled: false }) }, moderationCase: { findUnique: async () => null, create: async () => { writes++; return {} as ModerationCase; }, update: async () => undefined } };
  await assert.rejects(submitModerationAction(store, { guildId: '123456789012345678', actorId: '123456789012345679', targetId: '123456789012345680', action: 'BAN', reason: 'test', operationId: 'operation-disabled-0001' }), /désactivé/);
  assert.equal(writes, 0);
});

test('concurrent identical submissions keep one ban decision and reject changed payloads', { skip: process.env.RUN_POSTGRES_INTEGRATION !== '1' }, async () => {
  const { prisma } = await import('@veyrobot/db');
  const guildId = `9${crypto.randomUUID().replace(/\D/g, '').padEnd(17, '0').slice(0, 17)}`;
  const targetId = '123456789012345680';
  const actorId = '123456789012345679';
  const operationId = `test-${crypto.randomUUID()}`;
  const input = { guildId, actorId, targetId, action: 'BAN' as const, reason: 'test concurrent submission', operationId };
  try {
    await prisma.guildConfig.create({ data: { guildId, updatedBy: actorId, memberActionsEnabled: true } });
    const [first, second] = await Promise.all([submitModerationAction(prisma, input), submitModerationAction(prisma, input)]);
    assert.equal(first.id, second.id);
    assert.equal(await prisma.moderationCase.count({ where: { operationId } }), 1);
    assert.equal((await prisma.guildTargetDecision.findUnique({ where: { guildId_targetId: { guildId, targetId } } }))?.generation, 1);
    await prisma.guildConfig.update({ where: { guildId }, data: { memberActionsEnabled: false } });
    assert.equal((await submitModerationAction(prisma, input)).id, first.id, 'an accepted operation stays idempotent after module disable');
    await assert.rejects(submitModerationAction(prisma, { ...input, reason: 'different' }), /déjà utilisé/);
  } finally {
    await prisma.moderationCase.deleteMany({ where: { guildId } });
    await prisma.guildTargetDecision.deleteMany({ where: { guildId } });
    await prisma.guildConfig.deleteMany({ where: { guildId } });
    await prisma.$disconnect();
  }
});

test('permission and hierarchy checks reject revoked permissions, equal roles, and the guild owner', () => {
  assert.equal(hasModerationPermission('KICK', PermissionFlagsBits.KickMembers), true);
  assert.equal(hasModerationPermission('KICK', PermissionFlagsBits.BanMembers), false);
  assert.equal(hasModerationPermission('BAN', 0n, true), true);
  assert.equal(canActOnTarget({ actorIsOwner: false, actorAboveTarget: false, botAboveTarget: true, targetIsOwner: false }), false);
  assert.equal(canActOnTarget({ actorIsOwner: true, actorAboveTarget: false, botAboveTarget: true, targetIsOwner: false }), true);
  assert.equal(canActOnTarget({ actorIsOwner: true, actorAboveTarget: true, botAboveTarget: true, targetIsOwner: true }), false);
});

test('a duplicate queue delivery cannot claim or execute a case twice', async () => {
  let fetches = 0;
  const store = { moderationCase: { updateMany: async () => ({ count: 0 }), update: async () => { throw new Error('must not write'); } } };
  await executeModerationAction({ operationId: 'operation-id-0001', guild: { members: { fetch: async () => { fetches++; } } } as unknown as Guild, caseRecord: { id: 'case-1' } as ModerationCase, store });
  assert.equal(fetches, 0);
});

test('a freshly revoked moderator permission records a failure before reaching the target', async () => {
  const store = fakeCaseStore();
  const actor = { id: '123456789012345679', permissions: { bitfield: 0n } };
  const bot = { id: '123456789012345681', permissions: { bitfield: PermissionFlagsBits.KickMembers } };
  const guild = { ownerId: '123456789012345682', members: { fetch: async () => actor, fetchMe: async () => bot } } as unknown as Guild;
  const row = { id: 'case-1', guildId: '123456789012345678', actorId: actor.id, targetId: '123456789012345680', action: 'KICK', reason: 'raison', status: 'requested', createdAt: new Date() } as ModerationCase;
  await executeModerationAction({ operationId: 'operation-id-0001', guild, caseRecord: row, store });
  const final = store.updates.at(-1)?.data;
  assert.equal(final?.status, 'failed');
  assert.match(String(final?.result), /permission Discord a été retirée/);
});

test('network failures are recorded as uncertain and are never reported as success', async () => {
  const store = fakeCaseStore();
  const actor = { id: '123456789012345679', permissions: { bitfield: PermissionFlagsBits.BanMembers } };
  const bot = { id: '123456789012345681', permissions: { bitfield: PermissionFlagsBits.BanMembers } };
  const guild = { ownerId: '123456789012345682', members: { fetch: async ({ user }: { user: string }) => { if (user === actor.id) return actor; throw new Error('ECONNRESET'); }, fetchMe: async () => bot } } as unknown as Guild;
  const row = { id: 'case-2', guildId: '123456789012345678', actorId: actor.id, targetId: '123456789012345680', action: 'BAN', reason: 'raison', status: 'requested', createdAt: new Date() } as ModerationCase;
  await executeModerationAction({ operationId: 'operation-id-0002', guild, caseRecord: row, store });
  assert.equal(store.updates.at(-1)?.data.status, 'uncertain');
});

test('an ambiguous ban response is stored uncertain and a redelivery cannot issue another ban', async () => {
  const store = fakeCaseStore();
  let banCalls = 0;
  const role = { comparePositionTo: () => 1 };
  const actor = { id: '123456789012345679', permissions: { bitfield: PermissionFlagsBits.BanMembers }, roles: { highest: role } };
  const bot = { permissions: { bitfield: PermissionFlagsBits.BanMembers }, roles: { highest: role } };
  const target = { id: '123456789012345680', roles: { highest: role }, ban: async () => { banCalls++; throw new Error('socket closed after request'); } };
  const guild = { ownerId: '123456789012345682', members: { fetch: async ({ user }: { user: string }) => user === actor.id ? actor : target, fetchMe: async () => bot } } as unknown as Guild;
  const row = { id: 'case-uncertain', guildId: '123456789012345678', actorId: actor.id, targetId: target.id, action: 'BAN', reason: 'raison', status: 'requested', createdAt: new Date() } as ModerationCase;
  await executeModerationAction({ operationId: 'operation-id-0006', guild, caseRecord: row, store });
  await executeModerationAction({ operationId: 'operation-id-0006', guild, caseRecord: row, store });
  assert.equal(banCalls, 1);
  assert.equal(store.updates.at(-1)?.data.status, 'uncertain');
});

test('two concurrent deliveries can claim a destructive action only once', async () => {
  const store = fakeCaseStore();
  let kicks = 0;
  const role = { comparePositionTo: () => 1 };
  const actor = { id: '123456789012345679', permissions: { bitfield: PermissionFlagsBits.KickMembers }, roles: { highest: role } };
  const bot = { permissions: { bitfield: PermissionFlagsBits.KickMembers }, roles: { highest: role } };
  const target = { id: '123456789012345680', roles: { highest: role }, kick: async () => { kicks++; } };
  const guild = { ownerId: '123456789012345682', members: { fetch: async ({ user }: { user: string }) => user === actor.id ? actor : target, fetchMe: async () => bot } } as unknown as Guild;
  const row = { id: 'case-3', guildId: '123456789012345678', actorId: actor.id, targetId: target.id, action: 'KICK', reason: 'raison', status: 'requested', createdAt: new Date() } as ModerationCase;
  await Promise.all([executeModerationAction({ operationId: 'operation-id-0003', guild, caseRecord: row, store }), executeModerationAction({ operationId: 'operation-id-0003', guild, caseRecord: row, store })]);
  assert.equal(kicks, 1);
  assert.equal(store.updates.at(-1)?.data.status, 'succeeded');
});

test('temporary ban expiry refuses to unban when the Discord ban marker changed', async () => {
  const store = fakeCaseStore('succeeded', 'scheduled');
  let unbans = 0;
  const guild = { members: { fetchMe: async () => ({ permissions: { has: () => true } }), unban: async () => { unbans++; } }, bans: { fetch: async () => ({ reason: 'nouvelle décision externe' }) } } as unknown as Guild;
  const row = { id: 'tempban-case', guildId: '123456789012345678', targetId: '123456789012345680', action: 'TEMPBAN', status: 'succeeded', expiresAt: new Date(Date.now() - 1), banMarker: 'veyro-case-operation-id-0004', expiryStatus: 'scheduled' } as ModerationCase;
  await expireTemporaryBan({ guild, caseRecord: row, store });
  assert.equal(unbans, 0);
  assert.equal(store.updates.at(-1)?.data.expiryStatus, 'uncertain');
});

test('temporary ban expiry records success only after Discord confirms the matching ban was removed', async () => {
  const store = fakeCaseStore('succeeded', 'scheduled');
  let unbans = 0;
  const marker = 'veyro-case-operation-id-0005';
  const guild = { members: { fetchMe: async () => ({ permissions: { has: () => true } }), unban: async () => { unbans++; } }, bans: { fetch: async () => ({ reason: `spam [${marker}]` }) } } as unknown as Guild;
  const row = { id: 'tempban-case-2', guildId: '123456789012345678', targetId: '123456789012345680', action: 'TEMPBAN', status: 'succeeded', expiresAt: new Date(Date.now() - 1), banMarker: marker, expiryStatus: 'scheduled' } as ModerationCase;
  await expireTemporaryBan({ guild, caseRecord: row, store });
  assert.equal(unbans, 1);
  assert.equal(store.updates.at(-1)?.data.expiryStatus, 'succeeded');
  assert.ok(store.updates.at(-1)?.data.unbannedAt instanceof Date);
});

test('temporary ban expiry is superseded by a newer in-app ban decision', async () => {
  const store = { ...fakeCaseStore('succeeded', 'scheduled'), guildTargetDecision: { findUnique: async () => ({ generation: 8 }) } };
  let unbans = 0;
  const marker = 'veyro-case-old';
  const guild = { members: { fetchMe: async () => ({ permissions: { has: () => true } }), unban: async () => { unbans++; } }, bans: { fetch: async () => ({ reason: `[${marker}]` }) } } as unknown as Guild;
  const row = { id: 'tempban-old', guildId: '123456789012345678', targetId: '123456789012345680', action: 'TEMPBAN', status: 'succeeded', expiresAt: new Date(Date.now() - 1), banMarker: marker, banGeneration: 7, expiryStatus: 'scheduled' } as ModerationCase;
  await expireTemporaryBan({ guild, caseRecord: row, store });
  assert.equal(unbans, 0);
  assert.equal(store.updates.at(-1)?.data.expiryStatus, 'superseded');
});

test('a ban decision recorded between marker read and unban request cancels the old expiry', async () => {
  const base = fakeCaseStore('succeeded', 'scheduled');
  let reads = 0;
  const store = { ...base, guildTargetDecision: { findUnique: async () => ({ generation: ++reads === 1 ? 7 : 8 }) } };
  let unbans = 0;
  const marker = 'veyro-case-race';
  const guild = { members: { fetchMe: async () => ({ permissions: { has: () => true } }), unban: async () => { unbans++; } }, bans: { fetch: async () => ({ reason: `[${marker}]` }) } } as unknown as Guild;
  const row = { id: 'tempban-race', guildId: '123456789012345678', targetId: '123456789012345680', action: 'TEMPBAN', status: 'succeeded', expiresAt: new Date(Date.now() - 1), banMarker: marker, banGeneration: 7, expiryStatus: 'scheduled' } as ModerationCase;
  await expireTemporaryBan({ guild, caseRecord: row, store });
  assert.equal(reads, 2);
  assert.equal(unbans, 0);
  assert.equal(base.updates.at(-1)?.data.expiryStatus, 'superseded');
});

test('an ambiguous temporary unban becomes uncertain and duplicate expiry does not retry it', async () => {
  const store = fakeCaseStore('succeeded', 'scheduled');
  let unbans = 0;
  const marker = 'veyro-case-ambiguous';
  const guild = { members: { fetchMe: async () => ({ permissions: { has: () => true } }), unban: async () => { unbans++; throw new Error('socket reset'); } }, bans: { fetch: async () => ({ reason: `[${marker}]` }) } } as unknown as Guild;
  const row = { id: 'tempban-ambiguous', guildId: '123456789012345678', targetId: '123456789012345680', action: 'TEMPBAN', status: 'succeeded', expiresAt: new Date(Date.now() - 1), banMarker: marker, expiryStatus: 'scheduled' } as ModerationCase;
  await Promise.all([expireTemporaryBan({ guild, caseRecord: row, store }), expireTemporaryBan({ guild, caseRecord: row, store })]);
  assert.equal(unbans, 1);
  assert.equal(store.updates.at(-1)?.data.expiryStatus, 'uncertain');
});

test('bulk deletion is bounded, filters by author and skips messages older than fourteen days', async () => {
  const store = fakeCaseStore();
  const author = '123456789012345680';
  const deleted: string[][] = [];
  let auditReason = '';
  const deletedIds: string[] = [];
  const recent = (id: string, user: string, age = 1_000) => ({ id, author: { id: user }, createdTimestamp: Date.now() - age });
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map([['1', recent('1', author)], ['2', recent('2', author, 15 * 24 * 60 * 60 * 1_000)], ['3', recent('3', '123456789012345681')]]) },
    bulkDelete: async (ids: string[]) => { deleted.push(ids); return new Map(ids.map(id => [id, {}])); },
  };
  const actor = { id: '123456789012345679', permissions: { bitfield: 0n } };
  const guild = { ownerId: '123456789012345682', channels: { fetch: async () => channel }, members: { fetch: async () => actor, fetchMe: async () => actor }, client: { rest: { post: async (_route: string, options: { body: { messages: string[] }; reason: string }) => { deleted.push(options.body.messages); auditReason = options.reason; }, delete: async (_route: string, options: { reason: string }) => { deletedIds.push('1'); auditReason = options.reason; } } } } as unknown as Guild;
  const row = { id: 'purge-case', guildId: '123456789012345678', actorId: actor.id, targetId: '123456789012345690', channelId: '123456789012345690', filterAuthorId: author, requestedCount: 3, action: 'PURGE_MESSAGES', reason: 'nettoyage', status: 'requested' } as ModerationCase;
  await executeModerationAction({ operationId: 'operation-purge-0001', guild, caseRecord: row, store });
  assert.deepEqual(deleted, []);
  assert.match(auditReason, /nettoyage/);
  assert.deepEqual(deletedIds, ['1']);
  assert.match(String(store.updates.at(-1)?.data.result), /requête de suppression pour 1 identifiant\(s\).*1 ancien\(s\) ignoré/);
});

test('channel lock restores only its stored SendMessages bit and leaves other overwrite fields alone', async () => {
  const store = fakeCaseStore();
  let sendMessages: boolean | null = null;
  let state: { active: boolean; originalSendMessages: string } | null = null;
  const edits: unknown[] = [];
  const channel = {
    isTextBased: () => true, messages: {}, permissionsFor: () => ({ has: () => true }),
    permissionOverwrites: {
      cache: { get: () => ({ allow: { has: () => false }, deny: { has: () => sendMessages === false } }) },
      edit: async (_role: unknown, options: { SendMessages: boolean | null }) => { edits.push(options); sendMessages = options.SendMessages; },
    },
  };
  const channelLockState = {
    findUnique: async () => state,
    upsert: async ({ create }: { create: { active: boolean; originalSendMessages: string } }) => { state = create; },
    update: async ({ data }: { data: { active: boolean } }) => { if (state) state.active = data.active; },
  };
  const actor = { id: '123456789012345679', permissions: { bitfield: 0n } };
  const guild = { ownerId: '123456789012345682', roles: { everyone: { id: '123456789012345678' } }, channels: { fetch: async () => channel }, members: { fetch: async () => actor, fetchMe: async () => actor } } as unknown as Guild;
  const base = { guildId: '123456789012345678', actorId: actor.id, targetId: '123456789012345690', channelId: '123456789012345690', reason: 'incident', status: 'requested' };
  await executeModerationAction({ operationId: 'operation-lock-0001', guild, caseRecord: { ...base, id: 'lock-case', action: 'LOCK_CHANNEL' } as ModerationCase, store: { ...store, channelLockState } });
  assert.equal(sendMessages, false);
  await executeModerationAction({ operationId: 'operation-unlock-0001', guild, caseRecord: { ...base, id: 'unlock-case', action: 'UNLOCK_CHANNEL' } as ModerationCase, store: { ...fakeCaseStore(), channelLockState } });
  assert.equal(sendMessages, null);
  assert.deepEqual(edits, [{ SendMessages: false }, { SendMessages: null }]);
});

test('restart reconciliation ignores active claims and marks stale claims uncertain without retrying', async () => {
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const store = { moderationCase: { updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { updates.push({ where, data }); } } };
  await markInterruptedOperationsUncertain(store, new Date('2026-10-13T12:00:00Z'));
  assert.deepEqual(updates[0]?.where, { status: 'running', claimLeaseUntil: { lt: new Date('2026-10-13T12:00:00Z') }, executionPhase: 'preparing' });
  assert.equal(updates[0]?.data.status, 'failed');
  assert.equal(updates[2]?.data.expiryStatus, 'uncertain');
});

test('an old executor cannot overwrite the uncertain state written after its lease expires', async () => {
  let status = 'running';
  const expiredLease = new Date('2026-10-13T11:00:00Z');
  const store = { moderationCase: { updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (where.status !== status) return { count: 0 };
    if (where.executionPhase && where.executionPhase !== 'discord_request_inflight') return { count: 0 };
    const lease = where.claimLeaseUntil as { lt?: Date } | undefined;
    if (lease?.lt && expiredLease >= lease.lt) return { count: 0 };
    status = String(data.status ?? status);
    return { count: 1 };
  } } };
  await markInterruptedOperationsUncertain(store, new Date('2026-10-13T12:00:00Z'));
  assert.equal(status, 'uncertain');
  const lateWrite = await store.moderationCase.updateMany({ where: { status: 'running', claimToken: 'stale' }, data: { status: 'succeeded' } });
  assert.equal(lateWrite.count, 0);
  assert.equal(status, 'uncertain');
});
