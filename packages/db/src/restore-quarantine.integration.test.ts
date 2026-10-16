import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prisma } from './index.js';
import { quarantineRestoredWork } from './restore-quarantine.js';
import { assertRecoveryAuthorized } from './recovery-gate.js';

test('restore quarantine marks pending work uncertain and revokes restored active sessions', { skip: process.env.RUN_POSTGRES_INTEGRATION !== '1' }, async () => {
  const id = randomUUID();
  const guildId = `restore-quarantine-${id}`;
  const operationId = `restore-quarantine-${id}`;
  const sessionIdHash = `restore-quarantine-${id}`;
  const recoveryEpoch = randomBytes(32).toString('hex');
  const now = new Date('2026-10-15T12:00:00Z');
  try {
    await prisma.moderationCase.createMany({ data: [
      { guildId, actorId: guildId, targetId: guildId, action: 'BAN', reason: 'restored request', status: 'requested', operationId },
      { guildId, actorId: guildId, targetId: `${guildId}-temp`, action: 'TEMPBAN', reason: 'restored expiry', status: 'succeeded', expiryStatus: 'scheduled', expiresAt: new Date(now.getTime() + 60_000) },
    ] });
    await prisma.sessionGrant.create({ data: { idHash: sessionIdHash, expiresAt: new Date(now.getTime() + 60_000) } });

    const result = await quarantineRestoredWork(prisma, recoveryEpoch, now);
    assert.equal(result.actionsQuarantined, 1);
    assert.equal(result.scheduledExpiriesQuarantined, 1);
    assert.ok(result.sessionsRevoked >= 1);
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { operationId } })).status, 'uncertain');
    const expiry = await prisma.moderationCase.findFirstOrThrow({ where: { guildId, action: 'TEMPBAN' } });
    assert.equal(expiry.expiryStatus, 'uncertain');
    assert.equal((await prisma.sessionGrant.findUniqueOrThrow({ where: { idHash: sessionIdHash } })).revokedAt?.toISOString(), now.toISOString());
    assert.equal((await prisma.recoveryGate.findUniqueOrThrow({ where: { id: 'singleton' } })).epochHash.length, 64);
    await assertRecoveryAuthorized(prisma, recoveryEpoch);
    await assert.rejects(assertRecoveryAuthorized(prisma, `${recoveryEpoch}-stale`));
  } finally {
    await prisma.moderationCase.deleteMany({ where: { guildId } });
    await prisma.sessionGrant.deleteMany({ where: { idHash: sessionIdHash } });
    await prisma.recoveryGate.deleteMany({ where: { id: 'singleton' } });
    await prisma.$disconnect();
  }
});
